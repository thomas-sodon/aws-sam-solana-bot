import { describe, expect, it, jest } from '@jest/globals';
import { TokenAmount } from '@raydium-io/raydium-sdk';
import { PublicKey } from '@solana/web3.js';

import { DEFAULT_TOKEN, newSplToken } from '../../src/config';
import { WorkerError, WorkerErrorType } from '../../src/errors/worker-error';
import {
    extractInputOutputTokens,
    extractInputTokenAmount,
    isBaseInput,
    isBaseToSplSwap,
    isSplToBaseSwap,
    isStableMint,
} from '../../src/handler/swap-handler';
import { getWalletTokenAmount } from '../../src/wallet';
import { WorkerContext } from '../../src/worker-context';
import {
    buildSwap,
    MEME_MINT,
    memeSell,
    OTHER_MINT,
    solBuy,
    tokenChange,
    TRADER,
    USDC_MINT,
    USDT_MINT,
} from './fixtures';

jest.mock('../../src/wallet');
const mockedGetWalletTokenAmount = jest.mocked(getWalletTokenAmount);

// max.buy.sol / max.buy.usdc from config/default.cjs
const MAX_BUY_SOL = 10000000;
const MAX_BUY_USDC = 5000000;

const wc = { wallet: { publicKey: new PublicKey(TRADER) } } as unknown as WorkerContext;
const memeToken = newSplToken(new PublicKey(MEME_MINT), 9);

describe('swap classification', () => {
    it('treats only USDC and USDT as stable mints', () => {
        expect(isStableMint(USDC_MINT)).toBe(true);
        expect(isStableMint(USDT_MINT)).toBe(true);
        expect(isStableMint(MEME_MINT)).toBe(false);
        expect(isStableMint(undefined)).toBe(false);
    });

    it('classifies a SOL -> SPL swap as a base-to-SPL buy', () => {
        const swap = solBuy(1000);
        expect(isBaseInput(swap)).toBe(true);
        expect(isBaseToSplSwap(swap)).toBe(true);
        expect(isSplToBaseSwap(swap)).toBe(false);
    });

    it('classifies a stablecoin -> SPL swap as a buy', () => {
        const swap = buildSwap({
            tokenInputs: [tokenChange(USDC_MINT, '1000000')],
            tokenOutputs: [tokenChange(MEME_MINT, '1')],
        });
        expect(isBaseInput(swap)).toBe(true);
        expect(isBaseToSplSwap(swap)).toBe(true);
    });

    it('classifies SPL -> SOL and SPL -> USDT swaps as sells', () => {
        expect(isSplToBaseSwap(memeSell())).toBe(true);
        expect(isBaseToSplSwap(memeSell())).toBe(false);
        const toUsdt = buildSwap({
            tokenInputs: [tokenChange(MEME_MINT, '1')],
            tokenOutputs: [tokenChange(USDT_MINT, '1')],
        });
        expect(isSplToBaseSwap(toUsdt)).toBe(true);
    });

    it('does not crash on empty token lists and treats them as unsupported', () => {
        const empty = buildSwap({});
        expect(isBaseInput(empty)).toBe(false);
        expect(isBaseToSplSwap(empty)).toBe(false);
        expect(isSplToBaseSwap(empty)).toBe(false);
    });
});

describe('extractInputOutputTokens', () => {
    it('buys the output token with WSOL', () => {
        const { inputToken, outputToken, targetMint } = extractInputOutputTokens(solBuy(1000));
        expect(inputToken).toBe(DEFAULT_TOKEN.WSOL);
        expect(outputToken.mint.toString()).toBe(MEME_MINT);
        expect(outputToken.decimals).toBe(6);
        expect(targetMint.toString()).toBe(MEME_MINT);
    });

    it('sells the input token for WSOL, keeping its decimals', () => {
        const { inputToken, outputToken, targetMint } = extractInputOutputTokens(memeSell());
        expect(inputToken.mint.toString()).toBe(MEME_MINT);
        expect(inputToken.decimals).toBe(9);
        expect(outputToken).toBe(DEFAULT_TOKEN.WSOL);
        expect(targetMint.toString()).toBe(MEME_MINT);
    });

    it('rejects SPL -> SPL swaps as unsupported', () => {
        const splToSpl = buildSwap({
            tokenInputs: [tokenChange(MEME_MINT, '1')],
            tokenOutputs: [tokenChange(OTHER_MINT, '1')],
        });
        expect(() => extractInputOutputTokens(splToSpl)).toThrow(
            expect.objectContaining({ workerErrorType: WorkerErrorType.SWAP_NOT_SUPPORTED }),
        );
    });
});

describe('extractInputTokenAmount', () => {
    it('mirrors a SOL buy below the cap with the same amount of WSOL', async () => {
        const amount = await extractInputTokenAmount(wc, solBuy(1234), DEFAULT_TOKEN.WSOL);
        expect(amount.token).toBe(DEFAULT_TOKEN.WSOL);
        expect(amount.raw.toString(10)).toBe('1234');
    });

    it('caps a large SOL buy at max.buy.sol', async () => {
        const amount = await extractInputTokenAmount(wc, solBuy(MAX_BUY_SOL * 50), DEFAULT_TOKEN.WSOL);
        expect(amount.raw.toString(10)).toBe(String(MAX_BUY_SOL));
    });

    it('sizes a stablecoin-funded buy as a max.buy.sol WSOL buy', async () => {
        const swap = buildSwap({
            tokenInputs: [tokenChange(USDC_MINT, '1')],
            tokenOutputs: [tokenChange(MEME_MINT, '1')],
        });
        const amount = await extractInputTokenAmount(wc, swap, DEFAULT_TOKEN.WSOL);
        expect(amount.raw.toString(10)).toBe(String(MAX_BUY_SOL));
    });

    it('sells the full wallet balance of the input token', async () => {
        mockedGetWalletTokenAmount.mockResolvedValue(new TokenAmount(memeToken, '777'));
        const amount = await extractInputTokenAmount(wc, memeSell(), memeToken);
        expect(mockedGetWalletTokenAmount).toHaveBeenCalledWith(wc, new PublicKey(MEME_MINT), wc.wallet.publicKey);
        expect(amount.raw.toString(10)).toBe('777');
    });

    it('uses the trader amount for a USDC sell below max.buy.usdc', async () => {
        const usdcSell = buildSwap({
            tokenInputs: [tokenChange(USDC_MINT, String(MAX_BUY_USDC - 1))],
            nativeOutput: { account: TRADER, amount: 1 } as any,
        });
        mockedGetWalletTokenAmount.mockResolvedValue(new TokenAmount(DEFAULT_TOKEN.USDC, '999999999'));
        const amount = await extractInputTokenAmount(wc, usdcSell, DEFAULT_TOKEN.USDC);
        expect(amount.raw.toString(10)).toBe(String(MAX_BUY_USDC - 1));
    });

    it('reports a zero balance as NO_TOKEN_BALANCE before checking for a token mismatch', async () => {
        mockedGetWalletTokenAmount.mockResolvedValue(new TokenAmount(memeToken, '0'));
        const otherToken = newSplToken(new PublicKey(OTHER_MINT), 9);
        const promise = extractInputTokenAmount(wc, memeSell(), otherToken);
        await expect(promise).rejects.toBeInstanceOf(WorkerError);
        await expect(promise).rejects.toMatchObject({ workerErrorType: WorkerErrorType.NO_TOKEN_BALANCE });
    });

    it('rejects a wallet balance for a different mint than the swap input', async () => {
        mockedGetWalletTokenAmount.mockResolvedValue(new TokenAmount(memeToken, '5'));
        const otherToken = newSplToken(new PublicKey(OTHER_MINT), 9);
        await expect(extractInputTokenAmount(wc, memeSell(), otherToken)).rejects.toThrow('Token mismatch');
    });
});
