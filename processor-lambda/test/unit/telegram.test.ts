import fetch from 'node-fetch';

import { describe, expect, it, jest } from '@jest/globals';

import { sendMessage, updateMessage } from '../../src/telegram/telegram';
import { WorkerContext } from '../../src/worker-context';
import { fakeEnv } from './fixtures';

jest.mock('node-fetch');
const mockedFetch = jest.mocked(fetch);

const respondWith = (body: unknown) =>
    mockedFetch.mockResolvedValue({ json: async () => body } as unknown as Awaited<ReturnType<typeof fetch>>);

describe('Telegram client', () => {
    it('sends HTML messages to the configured chat without link previews', async () => {
        respondWith({ ok: true, result: { message_id: 7 } });
        const response = await sendMessage(fakeEnv(), '<b>hi</b>');

        expect(response.result.message_id).toBe(7);
        const [url, init] = mockedFetch.mock.calls[0];
        expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage');
        expect(JSON.parse(String(init?.body))).toEqual({
            chat_id: 1,
            text: '<b>hi</b>',
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
        });
    });

    it("surfaces Telegram's error description when a send fails", async () => {
        respondWith({ ok: false, description: "Bad Request: can't parse entities" });
        await expect(sendMessage(fakeEnv(), '<b')).rejects.toThrow(
            "Failed to send message to Telegram: Bad Request: can't parse entities",
        );
    });

    it('edits the processing message in place', async () => {
        respondWith({ ok: true, result: { message_id: 7 } });
        const wc = { env: fakeEnv() } as WorkerContext;
        await updateMessage(wc, 'done', { message_id: 7 } as any);
        const [url, init] = mockedFetch.mock.calls[0];
        expect(url).toBe('https://api.telegram.org/bottest-token/editMessageText');
        expect(JSON.parse(String(init?.body))).toMatchObject({ message_id: 7, text: 'done', parse_mode: 'HTML' });
    });
});
