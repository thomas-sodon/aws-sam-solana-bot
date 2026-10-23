import { describe, expect, it } from '@jest/globals';

import { buildQuicknodeJupiterSwapBasePath, buildRpcUrl, buildShyftGraphQlPath, RpcProvider } from '../../src/config';
import { splitList } from '../../src/secrets';
import { addHyperlink, escapeHtml } from '../../src/telegram/message-generator';
import { buildBasepath } from '../../src/telegram/telegram';
import { describeError, errorMessage, getErrorObject, redactSecrets, shuffleArray } from '../../src/util';
import { fakeEnv } from './fixtures';

describe('splitList', () => {
    it('trims items and drops blanks', () => {
        expect(splitList(' a, b ,,c ,')).toEqual(['a', 'b', 'c']);
    });

    it('returns an empty list for missing or non-string values', () => {
        expect(splitList(undefined)).toEqual([]);
        expect(splitList(42)).toEqual([]);
        expect(splitList('')).toEqual([]);
    });
});

describe('escapeHtml', () => {
    it('escapes the characters Telegram HTML mode cares about', () => {
        expect(escapeHtml('<b>"Tom" & Jerry</b>')).toBe('&lt;b&gt;&quot;Tom&quot; &amp; Jerry&lt;/b&gt;');
    });

    it('renders null and undefined as an empty string', () => {
        expect(escapeHtml(undefined)).toBe('');
        expect(escapeHtml(null)).toBe('');
    });
});

describe('addHyperlink', () => {
    it('escapes both the text and the url', () => {
        expect(addHyperlink('a<b', 'https://example.com/?x=1&y="2"')).toBe(
            '<a href="https://example.com/?x=1&amp;y=&quot;2&quot;">a&lt;b</a>',
        );
    });
});

describe('getErrorObject', () => {
    it('copies own properties and can drop the stack', () => {
        const error = new Error('boom');
        expect(getErrorObject(error)).toHaveProperty('stack');
        expect(getErrorObject(error, true)).toEqual({ message: 'boom' });
    });
});

describe('shuffleArray', () => {
    it('keeps the same elements', () => {
        const input = [1, 2, 3, 4, 5];
        expect([...shuffleArray([...input])].sort()).toEqual(input);
    });
});

describe('redactSecrets', () => {
    const KEY = 'sEcReT-kEy-1234567890';

    it.each(Object.values(RpcProvider))('removes the %s API key from its RPC URL', (provider) => {
        const url = buildRpcUrl(provider, KEY);
        const redacted = redactSecrets(`request to ${url} failed, reason: socket hang up`);
        expect(redacted).not.toContain(KEY);
        expect(redacted).toContain(`${new URL(url).origin}/[REDACTED]`);
        expect(redacted).toContain('failed, reason: socket hang up');
    });

    it.each([
        ['QuickNode Jupiter', `${buildQuicknodeJupiterSwapBasePath(KEY)}/quote?inputMint=a`],
        ['Shyft GraphQL', buildShyftGraphQlPath(KEY)],
        ['Telegram Bot API', `${buildBasepath(fakeEnv({ TELEGRAM_BOT_TOKEN: KEY }))}/sendMessage`],
    ])('removes the credential from the %s URL', (_label, url) => {
        expect(redactSecrets(`FetchError: request to ${url} failed`)).not.toContain(KEY);
    });

    it('redacts key assignments outside a URL and leaves plain text alone', () => {
        expect(redactSecrets(`bad api-key=${KEY}&x=1`)).toBe('bad api-key=[REDACTED]&x=1');
        expect(redactSecrets(`api_key=${KEY}`)).toBe('api_key=[REDACTED]');
        expect(redactSecrets('429 Too Many Requests')).toBe('429 Too Many Requests');
        expect(redactSecrets('see https://dexscreener.com')).toBe('see https://dexscreener.com');
    });

    it('redacts URLs inside JSON-serialised errors', () => {
        const error = new Error(`request to https://rpc.helius.xyz/?api-key=${KEY} failed`);
        const described = describeError(error, true);
        expect(described).not.toContain(KEY);
        expect(JSON.parse(described)).toEqual({ message: 'request to https://rpc.helius.xyz/[REDACTED] failed' });
        expect(errorMessage(error)).toBe('request to https://rpc.helius.xyz/[REDACTED] failed');
        expect(errorMessage(`https://rpc.hellomoon.io/${KEY}`)).toBe('https://rpc.hellomoon.io/[REDACTED]');
    });
});
