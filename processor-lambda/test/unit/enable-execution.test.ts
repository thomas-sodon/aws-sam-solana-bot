import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { buildEnv, parseBooleanFlag } from '../../src/config';
import { buildSecrets } from '../../src/secrets';
import { Env } from '../../src/types';

jest.mock('../../src/secrets');
const mockedBuildSecrets = jest.mocked(buildSecrets);

describe('parseBooleanFlag', () => {
    it.each([
        [true, true],
        [false, false],
        ['true', true],
        [' TRUE ', true],
        ['false', false],
        ['False', false],
    ])('parses %p as %p', (value, expected) => {
        expect(parseBooleanFlag(value, !expected)).toBe(expected);
    });

    it.each([undefined, null])('falls back to the default for an absent value (%p)', (value) => {
        expect(parseBooleanFlag(value, true)).toBe(true);
        expect(parseBooleanFlag(value, false)).toBe(false);
    });

    it.each(['', 'yes', '0', 'no', 'off', 'disabled', 'False.', 1])(
        'fails closed (false) for the unrecognised value %p',
        (value) => {
            expect(parseBooleanFlag(value, true)).toBe(false);
            expect(parseBooleanFlag(value, false)).toBe(false);
        },
    );
});

describe('buildEnv ENABLE_EXECUTION', () => {
    const originalFlag = process.env.ENABLE_EXECUTION;
    afterEach(() => {
        if (originalFlag === undefined) delete process.env.ENABLE_EXECUTION;
        else process.env.ENABLE_EXECUTION = originalFlag;
    });

    const secrets = (extra: Record<string, unknown> = {}) => ({ TELEGRAM_CHAT_ID: 1, ...extra }) as unknown as Env;

    it('defaults to live execution when neither the secret nor the env var sets it', async () => {
        delete process.env.ENABLE_EXECUTION;
        mockedBuildSecrets.mockResolvedValue(secrets());
        await expect(buildEnv()).resolves.toMatchObject({ ENABLE_EXECUTION: true, TELEGRAM_CHAT_ID: 1 });
    });

    it('honours the Lambda env var string "false" (dry-run) and "true"', async () => {
        process.env.ENABLE_EXECUTION = 'false';
        mockedBuildSecrets.mockResolvedValue(secrets());
        expect((await buildEnv()).ENABLE_EXECUTION).toBe(false);

        process.env.ENABLE_EXECUTION = 'true';
        mockedBuildSecrets.mockResolvedValue(secrets());
        expect((await buildEnv()).ENABLE_EXECUTION).toBe(true);
    });

    it('lets a value in the secret override the env var', async () => {
        process.env.ENABLE_EXECUTION = 'true';
        mockedBuildSecrets.mockResolvedValue(secrets({ ENABLE_EXECUTION: 'false' }));
        expect((await buildEnv()).ENABLE_EXECUTION).toBe(false);
    });

    it('disables execution when the secret holds an unrecognised value', async () => {
        process.env.ENABLE_EXECUTION = 'true';
        mockedBuildSecrets.mockResolvedValue(secrets({ ENABLE_EXECUTION: 'off' }));
        expect((await buildEnv()).ENABLE_EXECUTION).toBe(false);
    });
});
