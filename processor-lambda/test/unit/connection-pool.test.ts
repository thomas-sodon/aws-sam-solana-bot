import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Connection } from '@solana/web3.js';

import { RpcProvider } from '../../src/config';
import { ConnectionPool } from '../../src/connection-pool';
import { sendMessage } from '../../src/telegram/telegram';
import { sleep } from '../../src/util';
import { fakeConnectionWrapper, fakeEnv } from './fixtures';

jest.mock('../../src/telegram/telegram');
jest.mock('../../src/util', () => ({
    ...jest.requireActual<typeof import('../../src/util')>('../../src/util'),
    sleep: jest.fn(async () => undefined),
}));

const mockedSleep = jest.mocked(sleep);
const mockedSendMessage = jest.mocked(sendMessage);

const rateLimitError = () => new Error('429 Too Many Requests: {"code": 429}');

const buildPool = () =>
    new ConnectionPool(fakeEnv(), [
        fakeConnectionWrapper(RpcProvider.HELIUS, 'aaaa'),
        fakeConnectionWrapper(RpcProvider.ALCHEMY, 'bbbb'),
        fakeConnectionWrapper(RpcProvider.CHAINSTACK, 'cccc'),
    ]);

const endpoint = (connection: Connection) => connection.rpcEndpoint.slice(-4);

describe('ConnectionPool rotation', () => {
    it('rotates round-robin, skipping the primary on the first call and wrapping around', () => {
        const pool = buildPool();
        const order = [1, 2, 3, 4].map(() => pool.getConnectionWrapper().rpcProvider);
        expect(order).toEqual([RpcProvider.ALCHEMY, RpcProvider.CHAINSTACK, RpcProvider.HELIUS, RpcProvider.ALCHEMY]);
    });

    it('selects a specific provider and continues rotating from it', () => {
        const pool = buildPool();
        expect(pool.getConnectionWrapper(RpcProvider.CHAINSTACK).rpcProvider).toBe(RpcProvider.CHAINSTACK);
        expect(pool.getConnectionWrapper().rpcProvider).toBe(RpcProvider.HELIUS);
        expect(() => pool.getConnectionWrapper(RpcProvider.SYNDICA)).toThrow('Connection not found for SYNDICA');
    });

    it('describes connections without leaking the full endpoint', () => {
        const pool = buildPool();
        pool.getConnectionWrapper(RpcProvider.ALCHEMY);
        expect(pool.getLastConnection()).toBe('ALCHEMY:bbbb:');
    });
});

describe('ConnectionPool.executeWithConnection', () => {
    beforeEach(() => {
        mockedSendMessage.mockResolvedValue({ ok: true } as any);
    });

    it('returns the callback result without retrying or alerting on success', async () => {
        const pool = buildPool();
        const result = await pool.executeWithConnection('getSlot', async (connection) => endpoint(connection));
        expect(result).toBe('bbbb');
        expect(mockedSleep).not.toHaveBeenCalled();
        expect(mockedSendMessage).not.toHaveBeenCalled();
    });

    it('retries ordinary errors on the next connection, waiting retryDelay, then gives up', async () => {
        const pool = buildPool();
        const seen: string[] = [];
        const promise = pool.executeWithConnection(
            'getAccountInfo',
            async (connection) => {
                seen.push(endpoint(connection));
                throw new Error('boom');
            },
            { retries: 2, retryDelay: 1000 },
        );
        await expect(promise).rejects.toThrow('boom');
        expect(seen).toEqual(['bbbb', 'cccc', 'aaaa']);
        expect(mockedSleep.mock.calls).toEqual([[1000], [1000]]);
        expect(mockedSendMessage).toHaveBeenCalledTimes(3);
        expect(mockedSendMessage.mock.calls[0][1]).toContain('Connection Error ALCHEMY:bbbb:getAccountInfo');
    });

    it('backs off exponentially on 429s up to the configured bound, then throws', async () => {
        const pool = buildPool();
        const callback = jest.fn(async () => {
            throw rateLimitError();
        });
        await expect(pool.executeWithConnection('getBlockHeight', callback)).rejects.toThrow('429');
        // rateLimit.connection429 = { maxRetries: 5, baseDelay: 250, maxDelay: 4000 }
        expect(callback).toHaveBeenCalledTimes(6);
        expect(mockedSleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500, 1000, 2000, 4000]);
        expect(mockedSendMessage).not.toHaveBeenCalled();
    });

    it('does not spend the caller retries on 429s', async () => {
        const pool = buildPool();
        const failures = [rateLimitError(), rateLimitError(), new Error('flaky')];
        const callback = jest.fn(async () => {
            const failure = failures.shift();
            if (failure) throw failure;
            return 'ok';
        });
        await expect(pool.executeWithConnection('getMint', callback, { retries: 1, retryDelay: 10 })).resolves.toBe(
            'ok',
        );
        expect(callback).toHaveBeenCalledTimes(4);
        expect(mockedSleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500, 10]);
    });

    it('keeps the 429 budget across ordinary retries, so total attempts stay bounded', async () => {
        const pool = buildPool();
        const callback = jest.fn(async () => {
            throw callback.mock.calls.length === 1 ? new Error('flaky') : rateLimitError();
        });
        await expect(pool.executeWithConnection('getMint', callback, { retries: 3 })).rejects.toThrow('429');
        // first call + 3 caller retries + 5 rate-limit retries; the 429 counter is never reset
        expect(callback).toHaveBeenCalledTimes(1 + 3 + 5);
        expect(mockedSleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500, 1000, 2000, 4000]);
    });

    it('does not alert Telegram for missing accounts and tolerates errors without a message', async () => {
        const pool = buildPool();
        await expect(
            pool.executeWithConnection('getAccountInfo', async () => {
                throw new Error('could not find account');
            }),
        ).rejects.toThrow('could not find account');
        expect(mockedSendMessage).not.toHaveBeenCalled();

        await expect(
            pool.executeWithConnection('getAccountInfo', async () => {
                throw { code: -32005 };
            }),
        ).rejects.toEqual({ code: -32005 });
        expect(mockedSendMessage).toHaveBeenCalledTimes(1);
    });

    it('swallows Telegram failures from fire-and-forget alerts', async () => {
        mockedSendMessage.mockRejectedValue(new Error('telegram down'));
        const pool = buildPool();
        await expect(
            pool.executeWithConnection('getSlot', async () => {
                throw new Error('<rpc> & failure');
            }),
        ).rejects.toThrow('<rpc> & failure');
        await new Promise((resolve) => setImmediate(resolve));
        expect(mockedSendMessage.mock.calls[0][1]).toContain('&lt;rpc&gt; &amp; failure');
    });
});

describe('ConnectionPool.execute', () => {
    it('retries a connection-less call and only sleeps for rate limits', async () => {
        mockedSendMessage.mockResolvedValue({ ok: true } as any);
        const pool = buildPool();
        const failures = [rateLimitError(), new Error('flaky')];
        const callback = jest.fn(async () => {
            const failure = failures.shift();
            if (failure) throw failure;
            return 42;
        });
        await expect(pool.execute('dexScreener', callback, { retries: 2, retryDelay: 50 })).resolves.toBe(42);
        expect(callback).toHaveBeenCalledTimes(3);
        expect(mockedSleep.mock.calls).toEqual([[50]]);
    });
});
