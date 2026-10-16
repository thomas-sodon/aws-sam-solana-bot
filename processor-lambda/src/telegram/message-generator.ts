/**
 * Escapes text for Telegram's HTML parse mode. Telegram only requires &, < and > to be escaped
 * in text; double quotes are escaped as well so the output is also safe inside attribute values.
 *
 * @param {unknown} value - Dynamic text (descriptions, error messages, JSON dumps) to escape.
 * @returns {string} The escaped text.
 */
export const escapeHtml = (value: unknown): string =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

/**
 * Adds hyperlinks within responses from a Telegram bot.
 *
 * @param {string} text - The text to be modified.
 * @param {string} url - The URL to be added as a hyperlink.
 * @returns {string} The modified text with the hyperlink.
 */
export const addHyperlink = (text: string, url: string): string =>
    `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;
