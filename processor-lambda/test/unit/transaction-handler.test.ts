import { describe, expect, it } from '@jest/globals';
import { TokenAmount } from '@raydium-io/raydium-sdk';
import { PublicKey, SignatureStatus } from '@solana/web3.js';

import { DEFAULT_TOKEN, newSplToken } from '../../src/config';
import { HeliusError, HeliusErrorType } from '../../src/errors/helius-error';
import { JupiterError, JupiterErrorType } from '../../src/errors/jupiter-error';
import { TransactionError, TransactionErrorType } from '../../src/errors/transaction-error';
import { WorkerError, WorkerErrorType } from '../../src/errors/worker-error';
import { checkSignatureStatus, executeSimulation, logElapsedTime } from '../../src/handler/transaction-handler';
import { SigningResult, TransactionInputs } from '../../src/types';
import { WorkerContext } from '../../src/worker-context';
import { MEME_MINT } from './fixtures';

const memeToken = newSplToken(new PublicKey(MEME_MINT), 6);
const transactionInputs: TransactionInputs = {
    inputTokenAmount: new TokenAmount(DEFAULT_TOKEN.WSOL, 1000),
    outputToken: memeToken,
    targetMint: memeToken.mint,
};
const loggingDetails = { startTime: new Date(), transactionInputs, numRetries: 2 };
const SIGNATURE = 'FakeSignature1111111111111111111111111111111';

/** A WorkerContext whose pool hands the callback a fake connection; nothing reaches an RPC node. */
const wcWith = (connection: Record<string, unknown>) =>
    ({
        getConnectionPool: () => ({
            executeWithConnection: (_name: string, callback: (connection: unknown) => Promise<unknown>) =>
                callback(connection),
        }),
    }) as unknown as WorkerContext;

const statusOf = (status: Partial<SignatureStatus> | null) =>
    wcWith({ getSignatureStatus: async () => ({ context: { slot: 1 }, value: status }) });

const instructionError = (custom: number) => ({ InstructionError: [3, { Custom: custom }] });

describe('checkSignatureStatus', () => {
    it('reports success for a confirmed transaction without errors', async () => {
        const result = await checkSignatureStatus(
            statusOf({ confirmationStatus: 'confirmed', err: null }),
            SIGNATURE,
            loggingDetails,
        );
        expect(result).toMatchObject({ txSuccess: true, signature: SIGNATURE });
    });

    it('keeps polling (txSuccess false) while the transaction is only processed or unknown', async () => {
        const processed = await checkSignatureStatus(
            statusOf({ confirmationStatus: 'processed', err: null }),
            SIGNATURE,
            loggingDetails,
        );
        expect(processed.txSuccess).toBe(false);
        expect((await checkSignatureStatus(statusOf(null), SIGNATURE, loggingDetails)).txSuccess).toBe(false);
    });

    it.each([
        [6001, TransactionErrorType.SLIPPAGE],
        [17, TransactionErrorType.ACCOUNT_FROZEN],
        [1, TransactionErrorType.BLOCKHASH_EXPIRED],
    ])('maps on-chain Custom error %p to %p', async (custom, expectedType) => {
        const promise = checkSignatureStatus(
            statusOf({ confirmationStatus: 'finalized', err: instructionError(custom) as any }),
            SIGNATURE,
            loggingDetails,
        );
        await expect(promise).rejects.toBeInstanceOf(TransactionError);
        await expect(promise).rejects.toMatchObject({ transactionErrorType: expectedType, transactionInputs });
    });
});

describe('executeSimulation', () => {
    const signingResult = { versionedTransaction: {}, signature: SIGNATURE } as unknown as SigningResult;

    it('derives success from a single simulation result', async () => {
        const ok = wcWith({ simulateTransaction: async () => ({ value: { err: null, logs: ['log'] } }) });
        await expect(executeSimulation(ok, signingResult, loggingDetails)).resolves.toMatchObject({ txSuccess: true });

        const failed = wcWith({
            simulateTransaction: async () => ({ value: { err: 'InsufficientFunds', logs: null } }),
        });
        await expect(executeSimulation(failed, signingResult, loggingDetails)).resolves.toMatchObject({
            txSuccess: false,
            status: null,
        });
    });
});

describe('error types', () => {
    it('TransactionError prefixes the type and appends a Jupiter swap link', () => {
        const error = new TransactionError(TransactionErrorType.SLIPPAGE, transactionInputs, 3, 'details');
        expect(error.name).toBe('TransactionError');
        expect(error.message).toBe(
            `Slippage occurred: details\nhttps://jup.ag/swap/${DEFAULT_TOKEN.WSOL.mint.toString()}-${MEME_MINT}`,
        );
        expect(error.elapsedTime).toBe(3);
    });

    it('WorkerError, JupiterError and HeliusError format "<type>: <message>"', () => {
        expect(new WorkerError(WorkerErrorType.NO_TOKEN_BALANCE, 'mint').message).toBe('No token balance: mint');
        expect(new WorkerError(WorkerErrorType.SWAP_NOT_SUPPORTED).message).toBe('Swap not currently supported');
        const jupiterError = new JupiterError(JupiterErrorType.TOKEN_NOT_TRADABLE, 'x');
        expect(jupiterError).toMatchObject({ name: 'JupiterError', message: 'Token is not tradable: x' });
        expect(new HeliusError(HeliusErrorType.PRIORITY_FEE_FAIL).name).toBe('HeliusError');
    });
});

describe('logElapsedTime', () => {
    it('links the signature and escapes the status JSON for Telegram HTML', () => {
        const message = logElapsedTime(1.25, 2, SIGNATURE, { err: '<bad>' } as unknown as SignatureStatus);
        expect(message).toContain('Elapsed time: 1.25 seconds over 2 retries');
        expect(message).toContain(`<a href="https://solscan.io/tx/${SIGNATURE}">${SIGNATURE}</a>`);
        expect(message).toContain('&quot;err&quot;: &quot;&lt;bad&gt;&quot;');
        expect(logElapsedTime(1, 0)).toBe('Elapsed time: 1 seconds over 0 retries');
    });
});
