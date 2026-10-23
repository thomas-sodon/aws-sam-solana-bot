import { EnrichedTransaction, TransactionType } from 'helius-sdk';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { lambdaHandler } from '../../src/app';
import { WorkerError, WorkerErrorType } from '../../src/errors/worker-error';
import { handleRequest } from '../../src/handler/request-handler';
import { processSwapEvent } from '../../src/handler/swap-handler';
import { claimSignature } from '../../src/idempotency';
import { sendMessage, updateMessage } from '../../src/telegram/telegram';
import { SwapProgress } from '../../src/types';
import { WorkerContext } from '../../src/worker-context';
import { buildEvent } from '../util/test-data-factory';
import { fakeEnv } from './fixtures';

// Nothing here may load secrets or open connections: the context, Telegram and swap execution are all fakes
jest.mock('../../src/worker-context');
jest.mock('../../src/telegram/telegram');
jest.mock('../../src/handler/swap-handler');
jest.mock('../../src/idempotency');

const mockedBuild = jest.mocked(WorkerContext.build);
const mockedSendMessage = jest.mocked(sendMessage);
const mockedUpdateMessage = jest.mocked(updateMessage);
const mockedProcessSwapEvent = jest.mocked(processSwapEvent);
const mockedClaimSignature = jest.mocked(claimSignature);

const fakeWc = () =>
    ({
        env: fakeEnv(),
        connectionPool: { getLastConnection: () => 'HELIUS:abcd:getSlot' },
    }) as unknown as WorkerContext;

const webhookBody = (tx: Partial<EnrichedTransaction>) => JSON.stringify([tx]);

describe('lambdaHandler auth', () => {
    beforeEach(() => {
        mockedBuild.mockResolvedValue(fakeWc());
        mockedSendMessage.mockResolvedValue({ ok: true, result: { message_id: 1 } } as any);
        mockedClaimSignature.mockResolvedValue('claimed');
    });

    it.each([
        ['a wrong Authorization header', { Authorization: 'wrong' }, webhookBody({ description: 'x' })],
        ['a missing Authorization header', {}, webhookBody({ description: 'x' })],
        ['an empty body', { Authorization: 'expected-auth' }, ''],
    ])('ignores requests with %s without processing or notifying', async (_label, headers, body) => {
        const response = await lambdaHandler(buildEvent({ headers, body }));
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ message: 'Not processed' });
        expect(mockedProcessSwapEvent).not.toHaveBeenCalled();
        expect(mockedSendMessage).not.toHaveBeenCalled();
    });

    it('processes an authorised swap and edits the escaped Telegram processing message', async () => {
        mockedProcessSwapEvent.mockResolvedValue({
            messageToSendTransfer: 'done',
            numRetries: 0,
            transactionResult: { txSuccess: false } as any,
        } as any);
        const response = await lambdaHandler(
            buildEvent({
                headers: { Authorization: 'expected-auth' },
                body: webhookBody({ type: TransactionType.SWAP, description: 'a <swap>', events: { swap: {} } as any }),
            }),
        );
        expect(response.statusCode).toBe(200);
        expect(mockedSendMessage.mock.calls[0][1]).toBe(`${SwapProgress.PROCESSING}: a &lt;swap&gt;`);
        expect(mockedUpdateMessage.mock.calls[0][1]).toBe('done\nRetries: 0');
    });

    it('reports a missing token balance as an invalid swap rather than an error', async () => {
        mockedProcessSwapEvent.mockRejectedValue(new WorkerError(WorkerErrorType.NO_TOKEN_BALANCE, 'mint'));
        const response = await lambdaHandler(
            buildEvent({
                headers: { Authorization: 'expected-auth' },
                body: webhookBody({ type: TransactionType.SWAP, description: 'sell', events: { swap: {} } as any }),
            }),
        );
        expect(JSON.parse(response.body)).toEqual({ message: 'Processed.' });
        expect(mockedUpdateMessage.mock.calls[0][1]).toContain(SwapProgress.SWAP_INVALID);
        expect(mockedUpdateMessage.mock.calls[0][1]).toContain('No token balance found');
    });

    it('redacts API keys from unexpected error messages before they reach Telegram', async () => {
        mockedProcessSwapEvent.mockRejectedValue(
            new Error('request to https://rpc.helius.xyz/?api-key=leaky-key-123 failed, reason: ETIMEDOUT'),
        );
        await lambdaHandler(
            buildEvent({
                headers: { Authorization: 'expected-auth' },
                body: webhookBody({ type: TransactionType.SWAP, description: 'buy', events: { swap: {} } as any }),
            }),
        );
        const message = mockedUpdateMessage.mock.calls[0][1];
        expect(message).toContain(SwapProgress.ERROR);
        expect(message).toContain('https://rpc.helius.xyz/[REDACTED] failed, reason: ETIMEDOUT');
        expect(message).not.toContain('leaky-key-123');
    });
});

describe('lambdaHandler duplicate deliveries', () => {
    const swapBody = webhookBody({
        type: TransactionType.SWAP,
        signature: 'leader-sig',
        description: 'buy',
        events: { swap: {} } as any,
    });

    beforeEach(() => {
        mockedBuild.mockResolvedValue(fakeWc());
        mockedSendMessage.mockResolvedValue({ ok: true, result: { message_id: 1 } } as any);
        mockedProcessSwapEvent.mockResolvedValue({
            messageToSendTransfer: 'done',
            numRetries: 0,
            transactionResult: { txSuccess: false } as any,
        } as any);
    });

    it('claims the leader signature and trades a first delivery', async () => {
        mockedClaimSignature.mockResolvedValue('claimed');
        const response = await lambdaHandler(
            buildEvent({ headers: { Authorization: 'expected-auth' }, body: swapBody }),
        );
        expect(mockedClaimSignature).toHaveBeenCalledWith('leader-sig');
        expect(mockedProcessSwapEvent).toHaveBeenCalledTimes(1);
        expect(JSON.parse(response.body).message).toBe('Processed');
    });

    it('does not trade a redelivered signature and acknowledges it with 200', async () => {
        mockedClaimSignature.mockResolvedValue('duplicate');
        const response = await lambdaHandler(
            buildEvent({ headers: { Authorization: 'expected-auth' }, body: swapBody }),
        );
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ message: 'Duplicate' });
        expect(mockedProcessSwapEvent).not.toHaveBeenCalled();
        expect(mockedSendMessage).toHaveBeenCalledTimes(1);
        expect(mockedSendMessage.mock.calls[0][1]).toContain(SwapProgress.SWAP_IGNORED);
        expect(mockedSendMessage.mock.calls[0][1]).toContain('Duplicate webhook delivery');
    });

    it('reports an error and does not trade when the claim itself fails', async () => {
        mockedClaimSignature.mockRejectedValue(new Error('DynamoDB unavailable'));
        const response = await lambdaHandler(
            buildEvent({ headers: { Authorization: 'expected-auth' }, body: swapBody }),
        );
        expect(response.statusCode).toBe(500);
        expect(mockedProcessSwapEvent).not.toHaveBeenCalled();
        expect(mockedSendMessage.mock.calls[0][1]).toContain(SwapProgress.ERROR);
        expect(mockedSendMessage.mock.calls[0][1]).toContain('DynamoDB unavailable');
    });
});

describe('handleRequest', () => {
    it('ignores non-swap webhooks and escapes the dumped payload', async () => {
        const result = await handleRequest(fakeWc(), { type: TransactionType.TRANSFER, description: '<x>' } as any);
        expect(result.messageToSendTransfer.startsWith(SwapProgress.IGNORED)).toBe(true);
        expect(result.messageToSendTransfer).toContain('&quot;description&quot;: &quot;&lt;x&gt;&quot;');
        expect(mockedProcessSwapEvent).not.toHaveBeenCalled();
    });

    it('reports swaps without a swap event as errors', async () => {
        const result = await handleRequest(fakeWc(), { type: TransactionType.SWAP, events: {} } as any);
        expect(result.messageToSendTransfer).toBe(`${SwapProgress.ERROR}\nSwap event not found\n`);
    });
});
