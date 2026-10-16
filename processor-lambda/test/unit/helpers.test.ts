import { describe, expect, it } from '@jest/globals';

import { splitList } from '../../src/secrets';
import { addHyperlink, escapeHtml } from '../../src/telegram/message-generator';
import { getErrorObject, shuffleArray } from '../../src/util';

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
