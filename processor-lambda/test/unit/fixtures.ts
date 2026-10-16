import { SwapEvent, TokenBalanceChange } from 'helius-sdk';

import { PublicKey } from '@solana/web3.js';

import { DEFAULT_TOKEN, RpcProvider } from '../../src/config';
import { ConnectionWrapper } from '../../src/connection-pool';
import { Env } from '../../src/types';

// Deterministic, obviously fake addresses (valid 32-byte public keys, never real accounts)
export const TRADER = new PublicKey(Buffer.alloc(32, 1)).toString();
export const MEME_MINT = new PublicKey(Buffer.alloc(32, 2)).toString();
export const OTHER_MINT = new PublicKey(Buffer.alloc(32, 3)).toString();
export const USDC_MINT = DEFAULT_TOKEN.USDC.mint.toString();
export const USDT_MINT = DEFAULT_TOKEN.USDT.mint.toString();

export const tokenChange = (mint: string, tokenAmount: string, decimals = 6): TokenBalanceChange => ({
    mint,
    rawTokenAmount: { decimals, tokenAmount },
    tokenAccount: TRADER,
    userAccount: TRADER,
});

export const buildSwap = (swap: Partial<SwapEvent>): SwapEvent =>
    ({
        nativeInput: undefined,
        nativeOutput: undefined,
        tokenInputs: [],
        tokenOutputs: [],
        tokenFees: [],
        nativeFees: [],
        innerSwaps: [],
        ...swap,
    }) as unknown as SwapEvent;

/** SOL -> MEME buy of `lamports` */
export const solBuy = (lamports: number) =>
    buildSwap({
        nativeInput: { account: TRADER, amount: lamports } as any,
        tokenOutputs: [tokenChange(MEME_MINT, '1000')],
    });

/** MEME -> SOL sell */
export const memeSell = () =>
    buildSwap({
        tokenInputs: [tokenChange(MEME_MINT, '1000', 9)],
        nativeOutput: { account: TRADER, amount: 5 } as any,
    });

export const fakeEnv = (overrides: Partial<Env> = {}): Env =>
    ({
        ENABLE_EXECUTION: true,
        TELEGRAM_BOT_TOKEN: 'test-token',
        TELEGRAM_CHAT_ID: 1,
        HELIUS_WEBHOOK_AUTH_HEADER: 'expected-auth',
        SKIP_LIQUIDITY_CHECK: [],
        ...overrides,
    }) as Env;

export const fakeConnectionWrapper = (rpcProvider: RpcProvider, endpointSuffix: string): ConnectionWrapper =>
    ({
        rpcProvider,
        connection: { rpcEndpoint: `https://rpc.invalid/${endpointSuffix}` },
    }) as unknown as ConnectionWrapper;
