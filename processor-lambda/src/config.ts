import config from 'config';

import { BigNumberish, Currency, Percent, Token, TOKEN_PROGRAM_ID, TokenAmount } from '@raydium-io/raydium-sdk';
import { PublicKey } from '@solana/web3.js';

import { buildSecrets } from './secrets';
import { Env } from './types';

export enum RpcProvider {
    HELIUS = 'HELIUS',
    SHYFT = 'SHYFT',
    ALCHEMY = 'ALCHEMY',
    CHAINSTACK = 'CHAINSTACK',
    SYNDICA = 'SYNDICA',
    HELLOMOON = 'HELLOMOON',
}

export const buildRpcUrl = (rpcProvider: RpcProvider, apikey: string) => {
    switch (rpcProvider) {
        case RpcProvider.HELIUS:
            return `https://rpc.helius.xyz/?api-key=${apikey}`;
        case RpcProvider.SHYFT:
            return `https://rpc.shyft.to?api_key=${apikey}`;
        case RpcProvider.ALCHEMY:
            return `https://solana-mainnet.g.alchemy.com/v2/${apikey}`;
        case RpcProvider.CHAINSTACK:
            return `https://solana-mainnet.core.chainstack.com/${apikey}`;
        case RpcProvider.SYNDICA:
            return `https://solana-mainnet.api.syndica.io/api-token/${apikey}`;
        case RpcProvider.HELLOMOON:
            return `https://rpc.hellomoon.io/${apikey}`;
    }
};

export const getRandomShyftApikey = (env: Env) => {
    return env.SHYFT_RPC_POOL_API_KEYS[Math.floor(Math.random() * env.SHYFT_RPC_POOL_API_KEYS.length)];
};

export const newSplToken = (mint: PublicKey, decimals: number) => new Token(TOKEN_PROGRAM_ID, mint, decimals);
export const newTokenAmount = (mint: PublicKey, amount: BigNumberish, decimals: number) =>
    new TokenAmount(newSplToken(mint, decimals), amount);

const nativeMint = 'So11111111111111111111111111111111111111112';

export const DEFAULT_TOKEN = {
    SOL: new Currency(9, 'SOL', 'SOL'),
    WSOL: new Token(TOKEN_PROGRAM_ID, new PublicKey(nativeMint), 9, 'WSOL', 'WSOL'),
    USDC: new Token(TOKEN_PROGRAM_ID, new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), 6, 'USDC', 'USDC'),
    USDT: new Token(TOKEN_PROGRAM_ID, new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'), 6, 'USDT', 'USDT'),
    RAY: new Token(TOKEN_PROGRAM_ID, new PublicKey('4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'), 6, 'RAY', 'RAY'),
    'RAY_USDC-LP': new Token(
        TOKEN_PROGRAM_ID,
        new PublicKey('FGYXP4vBkMEtKhxrmEBcWN8VNmXX8qNgEJpENKDETZ4Y'),
        6,
        'RAY-USDC',
        'RAY-USDC',
    ),
};

export const buildQuicknodeJupiterSwapBasePath = (apikey: string) => `https://jupiter-swap-api.quiknode.pro/${apikey}`; // Jupiter API base path
export const buildShyftGraphQlPath = (apikey: string) => `https://programs.shyft.to/v0/graphql?api_key=${apikey}`; // Shyft GraphQL (Raydium pool lookup)
export const buildDexScreenerPath = (targetTokenMint: PublicKey) =>
    `https://api.dexscreener.com/latest/dex/tokens/${targetTokenMint.toString()}`; // DexScreener base path
export const raydiumSlippagePercent = new Percent(config.get<number>('raydium.slippage'), 100); // % slippage

/**
 * Parses a boolean flag that may arrive as a string (Lambda env vars, JSON secrets) or a real boolean.
 * Only "true"/"false" (case-insensitive) are recognised. The default applies only when the value is
 * absent (undefined/null); any other unrecognised value fails closed and returns false.
 */
export const parseBooleanFlag = (value: unknown, defaultValue: boolean): boolean => {
    if (value === undefined || value === null) return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
    }
    console.log(`Unrecognised boolean flag value ${JSON.stringify(value)}, treating it as false`);
    return false;
};

export const buildEnv = async (): Promise<Env> => {
    // A value in the secret takes precedence over the Lambda env var. When neither is set, live
    // execution stays enabled; a present but unrecognised value disables it (fails closed).
    const env = await buildSecrets();
    const rawFlag: unknown = 'ENABLE_EXECUTION' in env ? env.ENABLE_EXECUTION : process.env.ENABLE_EXECUTION;
    env.ENABLE_EXECUTION = parseBooleanFlag(rawFlag, true);
    return env;
};
