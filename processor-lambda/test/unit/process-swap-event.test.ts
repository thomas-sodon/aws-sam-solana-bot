import { EnrichedTransaction } from 'helius-sdk';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PublicKey } from '@solana/web3.js';

import { JupiterError, JupiterErrorType } from '../../src/errors/jupiter-error';
import { TransactionErrorType } from '../../src/errors/transaction-error';
import { WorkerError, WorkerErrorType } from '../../src/errors/worker-error';
import { processSwapEvent } from '../../src/handler/swap-handler';
import { executeSimulation, executeTransaction, signTransaction } from '../../src/handler/transaction-handler';
import { getPriorityFeeEstimateByMint } from '../../src/helius';
import { buildJupiterSwapTransaction } from '../../src/jupiter';
import { getMintInfo, getPoolInfo } from '../../src/pool-info';
import { buildRaydiumSwapTransaction } from '../../src/raydium';
import { HeliusPriorityLevel, SigningResult, SwapProgress, SwapProvider, SwapTransaction } from '../../src/types';
import { WorkerContext } from '../../src/worker-context';
import { fakeEnv, MEME_MINT, solBuy, TRADER } from './fixtures';

jest.mock('../../src/pool-info');
jest.mock('../../src/helius');
jest.mock('../../src/jupiter');
jest.mock('../../src/raydium');
jest.mock('../../src/wallet');
jest.mock('../../src/handler/transaction-handler', () => ({
    ...jest.requireActual<typeof import('../../src/handler/transaction-handler')>(
        '../../src/handler/transaction-handler',
    ),
    signTransaction: jest.fn(),
    executeTransaction: jest.fn(),
    executeSimulation: jest.fn(),
}));

const mocked = {
    getMintInfo: jest.mocked(getMintInfo),
    getPoolInfo: jest.mocked(getPoolInfo),
    getPriorityFee: jest.mocked(getPriorityFeeEstimateByMint),
    jupiter: jest.mocked(buildJupiterSwapTransaction),
    raydium: jest.mocked(buildRaydiumSwapTransaction),
    sign: jest.mocked(signTransaction),
    execute: jest.mocked(executeTransaction),
    simulate: jest.mocked(executeSimulation),
};

const SIGNATURE = 'FakeSignature1111111111111111111111111111111';
const swapTransaction = { versionedTransaction: {}, lastValidBlockHeight: 100 } as unknown as SwapTransaction;
const successResult = { txSuccess: true, elapsedTime: 1.5, status: null, signature: SIGNATURE };

const buildWc = (enableExecution = true) =>
    new WorkerContext(
        fakeEnv({ ENABLE_EXECUTION: enableExecution }),
        { publicKey: new PublicKey(TRADER) } as any,
        {
            getLastConnection: () => 'fake',
        } as any,
    );

const requestBody = (description: string) =>
    ({ description, feePayer: TRADER, source: 'JUPITER' }) as unknown as EnrichedTransaction;

describe('processSwapEvent', () => {
    beforeEach(() => {
        mocked.getMintInfo.mockResolvedValue({} as any);
        mocked.getPoolInfo.mockResolvedValue({ id: 'pool' } as any);
        mocked.getPriorityFee.mockResolvedValue(5000);
        mocked.jupiter.mockResolvedValue(swapTransaction);
        mocked.raydium.mockResolvedValue(swapTransaction);
        mocked.sign.mockReturnValue({ signature: SIGNATURE } as SigningResult);
        mocked.execute.mockResolvedValue({ ...successResult });
        mocked.simulate.mockResolvedValue({ ...successResult });
    });

    it('executes a mirrored buy via Jupiter and builds an escaped success message', async () => {
        const wc = buildWc(true);
        const result = await processSwapEvent(
            wc,
            'JUPITER',
            solBuy(1000),
            requestBody('x swapped 1 SOL for <b>MEME</b>'),
        );

        expect(mocked.execute).toHaveBeenCalledTimes(1);
        expect(mocked.simulate).not.toHaveBeenCalled();
        expect(mocked.jupiter.mock.calls[0][3]).toBe(5000);
        expect(result.swapProvider).toBe(SwapProvider.JUPITER);
        expect(result.transactionResult.txSuccess).toBe(true);
        expect(result.numRetries).toBe(0);
        expect(wc.swapMint?.target.toString()).toBe(MEME_MINT);

        const message = result.messageToSendTransfer;
        expect(message.startsWith(SwapProgress.SUCCESS)).toBe(true);
        expect(message).toContain('1 SOL for &lt;b&gt;MEME&lt;/b&gt;');
        expect(message).not.toContain('<b>');
        expect(message).toContain(`<a href="https://solscan.io/tx/${SIGNATURE}">Solscan</a>`);
        expect(message).toContain(`https://rugcheck.xyz/tokens/${MEME_MINT}`);
    });

    it('only simulates when ENABLE_EXECUTION is false and reports NOT EXECUTED without a tx link', async () => {
        const result = await processSwapEvent(buildWc(false), 'JUPITER', solBuy(1000), requestBody('a swapped b'));
        expect(mocked.simulate).toHaveBeenCalledTimes(1);
        expect(mocked.execute).not.toHaveBeenCalled();
        expect(result.messageToSendTransfer.startsWith(SwapProgress.NOT_EXECUTED)).toBe(true);
        expect(result.messageToSendTransfer).not.toContain('solscan.io/tx');
    });

    it('does not retry a failed simulation', async () => {
        mocked.simulate.mockResolvedValue({ ...successResult, txSuccess: false });
        await expect(
            processSwapEvent(buildWc(false), 'JUPITER', solBuy(1000), requestBody('a swapped b')),
        ).rejects.toMatchObject({ transactionErrorType: TransactionErrorType.SIMULATION_FAILED });
        expect(mocked.simulate).toHaveBeenCalledTimes(1);
        expect(mocked.execute).not.toHaveBeenCalled();
    });

    it('falls back to Raydium when Jupiter reports the token is not tradable', async () => {
        mocked.jupiter.mockRejectedValue(new JupiterError(JupiterErrorType.TOKEN_NOT_TRADABLE, 'nope'));
        const result = await processSwapEvent(buildWc(), 'JUPITER', solBuy(1000), requestBody('a swapped b'));
        expect(mocked.raydium).toHaveBeenCalledTimes(1);
        expect(mocked.raydium.mock.calls[0][3]).toBe(5000);
        expect(result.swapProvider).toBe(SwapProvider.RAYDIUM);
        expect(result.numRetries).toBe(1);
    });

    it('drops an over-limit priority fee: retries at LOW, then uses the configured Jupiter default', async () => {
        mocked.getPriorityFee.mockResolvedValue(10 ** 9);
        await processSwapEvent(buildWc(), 'JUPITER', solBuy(1000), requestBody('a swapped b'));
        expect(mocked.getPriorityFee).toHaveBeenCalledTimes(2);
        expect(mocked.getPriorityFee.mock.calls[1][2]).toBe(HeliusPriorityLevel.LOW);
        expect(mocked.jupiter.mock.calls[0][3]).toBe('auto');
    });

    it('does not retry when the pool liquidity is too low', async () => {
        mocked.getPoolInfo.mockRejectedValue(new WorkerError(WorkerErrorType.LOW_POOL_LIQUIDITY, 'thin'));
        await expect(
            processSwapEvent(buildWc(), 'JUPITER', solBuy(1000), requestBody('a swapped b')),
        ).rejects.toMatchObject({ workerErrorType: WorkerErrorType.LOW_POOL_LIQUIDITY });
        expect(mocked.getPoolInfo).toHaveBeenCalledTimes(1);
        expect(mocked.jupiter).not.toHaveBeenCalled();
    });

    it('skips the liquidity check for buys copied from allow-listed traders', async () => {
        const wc = new WorkerContext(fakeEnv({ SKIP_LIQUIDITY_CHECK: [TRADER] }), buildWc().wallet, {} as any);
        await processSwapEvent(wc, 'JUPITER', solBuy(1000), requestBody('a swapped b'));
        expect(mocked.getPoolInfo.mock.calls[0][2]).toBe(false);
    });
});
