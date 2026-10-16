import config from 'config';
import { gql, GraphQLClient } from 'graphql-request';

import { OpenOrders } from '@project-serum/serum';
import {
    ApiPoolInfoV4,
    Liquidity,
    LIQUIDITY_STATE_LAYOUT_V4,
    Market,
    MARKET_STATE_LAYOUT_V3,
    SPL_MINT_LAYOUT,
} from '@raydium-io/raydium-sdk';
import { getMint, Mint } from '@solana/spl-token';
import { Connection, PublicKey } from '@solana/web3.js';

import { buildDexScreenerPath, buildShyftGraphQlPath, DEFAULT_TOKEN, getRandomShyftApikey } from './config';
import { ConnectionOptions, ConnectionPool } from './connection-pool';
import { WorkerError, WorkerErrorType } from './errors/worker-error';
import { Env } from './types';
import { WorkerContext } from './worker-context';

export type Raydium_LiquidityPoolv4 = {
    _updatedAt: string;
    amountWaveRatio: number;
    baseDecimal: number;
    baseLotSize: number;
    baseMint: string;
    baseNeedTakePnl: number;
    baseTotalPnl: number;
    baseVault: string;
    depth: number;
    lpMint: string;
    lpReserve: number;
    lpVault: string;
    marketId: string;
    marketProgramId: string;
    maxOrder: number;
    maxPriceMultiplier: number;
    minPriceMultiplier: number;
    minSeparateDenominator: number;
    minSeparateNumerator: number;
    minSize: number;
    nonce: number;
    openOrders: string;
    orderbookToInitTime: number;
    owner: string;
    pnlDenominator: number;
    pnlNumerator: number;
    poolOpenTime: number;
    punishCoinAmount: number;
    punishPcAmount: number;
    quoteDecimal: number;
    quoteLotSize: number;
    quoteMint: string;
    quoteNeedTakePnl: number;
    quoteTotalPnl: number;
    quoteVault: string;
    resetFlag: number;
    state: number;
    status: number;
    swapBase2QuoteFee: number;
    swapBaseInAmount: number;
    swapBaseOutAmount: number;
    swapFeeDenominator: number;
    swapFeeNumerator: number;
    swapQuote2BaseFee: number;
    swapQuoteInAmount: number;
    swapQuoteOutAmount: number;
    systemDecimalValue: number;
    targetOrders: string;
    tradeFeeDenominator: number;
    tradeFeeNumerator: number;
    volMaxCutRatio: number;
    withdrawQueue: string;
    pubkey: string;
    liquidity: number;
};

export const getPoolInfo = async (wc: WorkerContext, targetTokenMint: PublicKey, checkPoolLiquidity?: boolean) => {
    const connectionPool = wc.getConnectionPool();
    let poolInfo: ApiPoolInfoV4;
    try {
        poolInfo = await getAndCheckPoolInfoFromDexScreener(connectionPool, targetTokenMint, checkPoolLiquidity);
        console.log(`Pool info from dexscreener: ${JSON.stringify(poolInfo, null, 2)}`);
    } catch (e) {
        // A low-liquidity verdict from DexScreener is final; only fall back to Shyft when the lookup itself failed
        if (e instanceof WorkerError && e.workerErrorType === WorkerErrorType.LOW_POOL_LIQUIDITY) {
            throw e;
        }
        console.log(`DexScreener pool lookup failed, falling back to Shyft: ${(e as Error)?.message ?? e}`);
        poolInfo = await getAndCheckPoolInfoFromShyft(wc.env, connectionPool, targetTokenMint, checkPoolLiquidity);
        console.log(`Pool info from shyft: ${JSON.stringify(poolInfo, null, 2)}`);
    }
    return poolInfo;
};

export const getMintInfo = async (connectionPool: ConnectionPool, targetTokenMint: PublicKey): Promise<Mint> => {
    const mintInfo = await connectionPool.executeWithConnection(
        'getMint',
        (connection: Connection) => getMint(connection, targetTokenMint),
        config.get<ConnectionOptions>('connectionOptions.getMint'),
    );
    if (!mintInfo.isInitialized) {
        throw new WorkerError(WorkerErrorType.MINT_NOT_INITIALIZED, targetTokenMint.toString());
    }
    if (!!mintInfo.freezeAuthority && mintInfo.address.toString() !== DEFAULT_TOKEN.USDC.mint.toString()) {
        throw new WorkerError(WorkerErrorType.FREEZE_AUTHORITY, targetTokenMint.toString());
    }
    if (!!mintInfo.mintAuthority && mintInfo.address.toString() !== DEFAULT_TOKEN.USDC.mint.toString()) {
        throw new WorkerError(WorkerErrorType.MINT_AUTHORITY, targetTokenMint.toString());
    }
    return mintInfo;
};

interface Pair {
    chainId: string;
    dexId: string;
    url: string;
    pairAddress: string;
    baseToken: {
        address: string;
        name: string;
        symbol: string;
    };
    quoteToken: {
        address: string;
        name: string;
        symbol: string;
    };
    priceNative: string;
    priceUsd?: string;
    txns: {
        m5: {
            buys: number;
            sells: number;
        };
        h1: {
            buys: number;
            sells: number;
        };
        h6: {
            buys: number;
            sells: number;
        };
        h24: {
            buys: number;
            sells: number;
        };
    };
    volume: {
        m5: number;
        h1: number;
        h6: number;
        h24: number;
    };
    priceChange: {
        m5: number;
        h1: number;
        h6: number;
        h24: number;
    };
    liquidity?: {
        usd?: number;
        base: number;
        quote: number;
    };
    fdv?: number;
    pairCreatedAt?: number;
}

export const getAndCheckPoolInfoFromDexScreener = async (
    connectionPool: ConnectionPool,
    targetTokenMint: PublicKey,
    checkPoolLiquidity?: boolean,
) => {
    const poolInfo = await connectionPool.execute(
        'getPoolInfoFromDexScreener',
        async () => {
            const data = await fetch(buildDexScreenerPath(targetTokenMint));
            const json = await data.json();
            console.log(`All pool info from dexscreener: ${JSON.stringify(json, null, 2)}`);
            const errorPrefix = `Error getting pool info from dexscreener`;
            if (json.error) {
                throw new Error(`${errorPrefix}: ${json.error}`);
            }
            if (!json.pairs || !Array.isArray(json.pairs) || json.pairs.length === 0) {
                throw new Error(
                    `${errorPrefix}: No data.pairs found for ${targetTokenMint.toString()} in ${JSON.stringify(json)}`,
                );
            }
            console.log('Should be able to find some pool info from dexscreener');
            const pools = json.pairs
                .filter(
                    (pair: Pair) =>
                        pair.chainId === 'solana' && pair.quoteToken.address === DEFAULT_TOKEN.WSOL.mint.toString(),
                )
                .filter((pair: Pair) => pair.liquidity)
                .sort((pairA: any, pairB: any) => pairB.liquidity.usd - pairA.liquidity.usd);
            if (pools.length === 0) {
                throw new Error(`${errorPrefix}: No filtered pairs found for ${targetTokenMint.toString()}`);
            }
            // Should be the largest pool first
            return pools[0];
        },
        config.get<ConnectionOptions>('connectionOptions.getPoolInfoFromDexScreener'),
    );

    if (checkPoolLiquidity && poolInfo.liquidity.usd < config.get<number>('minimumPoolLiquidity')) {
        throw new WorkerError(
            WorkerErrorType.LOW_POOL_LIQUIDITY,
            `Dexscreener: ${targetTokenMint.toString()} @ $${poolInfo.liquidity.usd.toFixed(2)}`,
        );
    }
    return formatAmmKeysById(connectionPool, poolInfo.pairAddress);
};

export const getPoolInfoFromShyft = async (
    env: Env,
    quoteMint: PublicKey,
    baseMint: PublicKey,
): Promise<Raydium_LiquidityPoolv4[]> => {
    const endpoint = buildShyftGraphQlPath(getRandomShyftApikey(env));

    const graphQLClient = new GraphQLClient(endpoint, {
        method: `POST`,
        jsonSerializer: {
            parse: JSON.parse,
            stringify: JSON.stringify,
        },
    });

    const query = gql`
        query MyQuery($where: Raydium_LiquidityPoolv4_bool_exp) {
            Raydium_LiquidityPoolv4(where: $where) {
                openOrders
                baseVault
                quoteVault
                baseDecimal
                quoteDecimal
                baseNeedTakePnl
                quoteNeedTakePnl
                baseMint
                quoteMint
                lpMint
                pubkey
            }
        }
    `;

    const variables = {
        where: {
            quoteMint: {
                _eq: quoteMint.toString(),
            },
            baseMint: {
                _eq: baseMint.toString(),
            },
        },
    };

    const response = await graphQLClient.request(query, variables);
    if ((response as any).errors) {
        throw new Error(`${JSON.stringify((response as any).errors)}`);
    }
    return (response as any).Raydium_LiquidityPoolv4 as Raydium_LiquidityPoolv4[];
};

export const raydiumShyftPoolNotExists = (v4Pools: Raydium_LiquidityPoolv4[]) =>
    !v4Pools || !Array.isArray(v4Pools) || v4Pools.length === 0;

// Doesn't have liquidity information, slow and unreliable
export const getAndCheckPoolInfoFromShyft = async (
    env: Env,
    connectionPool: ConnectionPool,
    targetTokenMint: PublicKey,
    checkPoolLiquidity?: boolean,
) => {
    let v4Pools: Raydium_LiquidityPoolv4[] = await getPoolInfoFromShyft(env, targetTokenMint, DEFAULT_TOKEN.WSOL.mint);
    if (raydiumShyftPoolNotExists(v4Pools)) {
        console.log('No pool found in shyft for target/WSOL, trying WSOL/target');
        v4Pools = await getPoolInfoFromShyft(env, DEFAULT_TOKEN.WSOL.mint, targetTokenMint);
        if (raydiumShyftPoolNotExists(v4Pools)) {
            throw new Error(`No pool found in shyft for token mint: ${targetTokenMint.toString()}`);
        }
    }
    v4Pools = await Promise.all(
        v4Pools.map(async (pool: Raydium_LiquidityPoolv4) => {
            const liquidity = await getPoolLiquidity(connectionPool, pool);
            return {
                ...pool,
                liquidity,
            };
        }),
    );
    const poolInfo = v4Pools.sort(
        (poolA: Raydium_LiquidityPoolv4, poolB: Raydium_LiquidityPoolv4) => poolB.liquidity - poolA.liquidity,
    )[0];
    console.log(`Pool info from shyft: ${JSON.stringify(poolInfo, null, 2)}`);
    if (checkPoolLiquidity && poolInfo.liquidity < config.get<number>('minimumPoolLiquidity')) {
        throw new WorkerError(
            WorkerErrorType.LOW_POOL_LIQUIDITY,
            `Shyft: ${targetTokenMint.toString()} @ $${poolInfo.liquidity.toFixed(2)}`,
        );
    }
    return formatAmmKeysById(connectionPool, poolInfo.pubkey);
};

//We have to check how much tokens are present in openbook market as well
export async function getPoolLiquidity(
    connectionPool: ConnectionPool,
    poolInfo: Raydium_LiquidityPoolv4,
): Promise<number> {
    const OPENBOOK_PROGRAM_ID = new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX');

    const openOrders = await connectionPool.executeWithConnection<OpenOrders>('OpenOrders.load', (connection) =>
        OpenOrders.load(connection, new PublicKey(poolInfo.openOrders), OPENBOOK_PROGRAM_ID),
    );

    const baseDecimal = 10 ** poolInfo.baseDecimal; // e.g. 10 ^ 6
    const quoteDecimal = 10 ** poolInfo.quoteDecimal;

    const baseTokenAmount = await connectionPool.executeWithConnection('getTokenAccountBalance', (connection) =>
        connection.getTokenAccountBalance(new PublicKey(poolInfo.baseVault)),
    );
    const quoteTokenAmount = await connectionPool.executeWithConnection('getTokenAccountBalance', (connection) =>
        connection.getTokenAccountBalance(new PublicKey(poolInfo.quoteVault)),
    );

    const basePnl = poolInfo.baseNeedTakePnl / baseDecimal;
    const quotePnl = poolInfo.quoteNeedTakePnl / quoteDecimal;

    const openOrdersBaseTokenTotal = openOrders.baseTokenTotal.toNumber() / baseDecimal;
    const openOrdersQuoteTokenTotal = openOrders.quoteTokenTotal.toNumber() / quoteDecimal;

    const base = (baseTokenAmount.value?.uiAmount || 0) + openOrdersBaseTokenTotal - basePnl;
    const quote = (quoteTokenAmount.value?.uiAmount || 0) + openOrdersQuoteTokenTotal - quotePnl;

    console.log('Pool info:', '\n base tokens in pool ' + base, '\n quote tokens in pool ' + quote);

    //Get the price of the tokens
    //We are using Jup pricing APIs, you can use whichever you want
    const priceInfo = await getTokenPrices(poolInfo.baseMint, poolInfo.quoteMint);
    const baseLiquidity = base * priceInfo.basePrice;
    const quoteLiquidity = quote * priceInfo.quotePrice;
    console.log(`Base Token liquidity: ${baseLiquidity} \n`);
    console.log(`Quote Token liquidity: ${quoteLiquidity} \n`);
    console.log(`Total liquidity in the pool: ${baseLiquidity + quoteLiquidity}`);
    return baseLiquidity + quoteLiquidity;
}

//Fetch token prices in USD using Jup pricing APIs
async function getTokenPrices(baseMint: string, quoteMint: string) {
    const baseMintPrice = await (await fetch(`https://price.jup.ag/v4/price?ids=${baseMint}`)).json();
    const quoteMintPrice = await (await fetch(`https://price.jup.ag/v4/price?ids=${quoteMint}`)).json();
    if (!baseMintPrice.data[baseMint]?.price || !quoteMintPrice.data[quoteMint]?.price) {
        throw new WorkerError(WorkerErrorType.PRICE_NOT_FOUND, `Base Mint: ${baseMint} Quote Mint: ${quoteMint}`);
    }
    return {
        basePrice: baseMintPrice.data[baseMint]?.price || 0,
        quotePrice: quoteMintPrice.data[quoteMint]?.price || 0,
    };
}

export async function formatAmmKeysById(connectionPool: ConnectionPool, pubkey: string): Promise<ApiPoolInfoV4> {
    const connectionOptions = config.get<ConnectionOptions>('connectionOptions.getAccountInfo');

    const getPubkeyInfoError = new Error(`get pubkey info error for ${pubkey}`);
    const account = await connectionPool.executeWithConnection(
        'getAccountInfo',
        async (connection: Connection) => {
            const account = await connection.getAccountInfo(new PublicKey(pubkey));
            if (account === null) throw getPubkeyInfoError;
            return account;
        },
        connectionOptions,
    );
    if (account === null) throw getPubkeyInfoError;
    const info = LIQUIDITY_STATE_LAYOUT_V4.decode(account.data);

    const marketId = info.marketId;
    const marketAccount = await connectionPool.executeWithConnection(
        'getAccountInfo',
        (connection) => connection.getAccountInfo(marketId),
        connectionOptions,
    );
    if (marketAccount === null) throw Error(`get market info error for ${marketId}`);
    const marketInfo = MARKET_STATE_LAYOUT_V3.decode(marketAccount.data);

    const lpMint = info.lpMint;
    const lpMintAccount = await connectionPool.executeWithConnection(
        'getAccountInfo',
        (connection) => connection.getAccountInfo(lpMint),
        connectionOptions,
    );

    if (lpMintAccount === null) throw Error(`get lp mint info error for ${lpMint}`);
    const lpMintInfo = SPL_MINT_LAYOUT.decode(lpMintAccount.data);

    return {
        id: pubkey,
        baseMint: info.baseMint.toString(),
        quoteMint: info.quoteMint.toString(),
        lpMint: info.lpMint.toString(),
        baseDecimals: info.baseDecimal.toNumber(),
        quoteDecimals: info.quoteDecimal.toNumber(),
        lpDecimals: lpMintInfo.decimals,
        version: 4,
        programId: account.owner.toString(),
        authority: Liquidity.getAssociatedAuthority({ programId: account.owner }).publicKey.toString(),
        openOrders: info.openOrders.toString(),
        targetOrders: info.targetOrders.toString(),
        baseVault: info.baseVault.toString(),
        quoteVault: info.quoteVault.toString(),
        withdrawQueue: info.withdrawQueue.toString(),
        lpVault: info.lpVault.toString(),
        marketVersion: 3,
        marketProgramId: info.marketProgramId.toString(),
        marketId: info.marketId.toString(),
        marketAuthority: Market.getAssociatedAuthority({
            programId: info.marketProgramId,
            marketId: info.marketId,
        }).publicKey.toString(),
        marketBaseVault: marketInfo.baseVault.toString(),
        marketQuoteVault: marketInfo.quoteVault.toString(),
        marketBids: marketInfo.bids.toString(),
        marketAsks: marketInfo.asks.toString(),
        marketEventQueue: marketInfo.eventQueue.toString(),
        lookupTableAccount: PublicKey.default.toString(),
    };
}
