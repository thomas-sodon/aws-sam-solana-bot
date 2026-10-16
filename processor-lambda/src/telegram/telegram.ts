import fetch from 'node-fetch';

import { Env } from '../types';
import { WorkerContext } from '../worker-context';

export const sendMessage = async (env: Env, message: string): Promise<TelegramResponse> => {
    const response = await fetch(`${buildBasepath(env)}/sendMessage`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML',
            link_preview_options: {
                is_disabled: true,
            },
        }),
    });
    const responseData = (await response.json()) as TelegramResponse;
    if (!responseData.ok) {
        throw new Error(
            `Failed to send message to Telegram: ${responseData.description ?? JSON.stringify(responseData, null, 2)}`,
        );
    }
    return responseData;
};

export type TelegramResponseResult = {
    message_id: number;
    from: {
        id: number;
        is_bot: boolean;
        first_name: string;
        username: string;
    };
    chat: {
        id: number;
        first_name: string;
        username: string;
        type: string;
    };
    date: number;
    text: string;
};

export type TelegramResponse = {
    ok: boolean;
    result: TelegramResponseResult;
    description?: string;
};

export const buildBasepath = (env: Env) => `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

export async function updateMessage(
    wc: WorkerContext,
    message: string,
    { message_id }: TelegramResponseResult,
): Promise<TelegramResponse> {
    const response = await fetch(`${buildBasepath(wc.env)}/editMessageText`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            chat_id: wc.env.TELEGRAM_CHAT_ID,
            message_id: message_id,
            text: message,
            parse_mode: 'HTML',
            link_preview_options: {
                is_disabled: true,
            },
        }),
    });
    const responseData = (await response.json()) as TelegramResponse;
    if (!responseData.ok) {
        throw new Error(`Failed to send message to Telegram: ${JSON.stringify(responseData, null, 2)}`);
    }
    return responseData;
}
