export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export const getElapsedTime = (startTime: Date): number => {
    const endTime = new Date();
    const elapsed = (endTime.getTime() - startTime.getTime()) / 1000;
    return elapsed;
};

export const getErrorObject = (error: any, removeStack?: boolean): Record<string, string> =>
    Object.getOwnPropertyNames(error).reduce((acc, curr) => {
        if (curr === 'stack' && removeStack) return acc;
        acc[curr] = error[curr];
        return acc;
    }, {} as any);

export const shuffleArray = (array: any[]): any[] => {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
};

// Matches http(s) URLs up to whitespace, quotes, angle brackets or a JSON escape
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>`\\]+/gi;
// Matches key/token assignments that can appear outside a URL, e.g. "api-key=abc" in an error string
const SECRET_PARAM_PATTERN = /\b(api[-_]?key|api[-_]?token|access[-_]?token|token)=([^&\s"'<>`\\]+)/gi;

/**
 * Removes credentials from text before it is logged or sent to Telegram.
 *
 * Every RPC provider, the QuickNode Jupiter endpoint, Shyft GraphQL and the Telegram Bot API carry
 * their key in the URL path or query string, and node-fetch transport errors embed the full request
 * URL. Each URL is therefore reduced to its origin, and any remaining `api-key=`-style assignment
 * has its value replaced.
 */
export const redactSecrets = (text: string): string =>
    text
        .replace(URL_PATTERN, (url) => {
            try {
                const { origin, pathname, search } = new URL(url);
                return (pathname === '/' || pathname === '') && !search ? origin : `${origin}/[REDACTED]`;
            } catch {
                return '[REDACTED_URL]';
            }
        })
        .replace(SECRET_PARAM_PATTERN, '$1=[REDACTED]');

/** JSON of an error's own properties with credentials redacted, for logs and operational alerts. */
export const describeError = (error: unknown, removeStack?: boolean): string =>
    redactSecrets(
        error !== null && typeof error === 'object'
            ? JSON.stringify(getErrorObject(error, removeStack))
            : JSON.stringify(String(error)),
    );

/** An error's message with credentials redacted. */
export const errorMessage = (error: unknown): string => redactSecrets(String((error as Error)?.message ?? error));
