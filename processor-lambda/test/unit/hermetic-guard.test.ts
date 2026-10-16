import net from 'net';

import { describe, expect, it } from '@jest/globals';

// Guards the guard: if test/setup/hermetic.ts stops being loaded, unit tests could silently hit the network
describe('unit test sandbox', () => {
    it('blocks outbound sockets and fetch', () => {
        expect(() => net.connect(443, 'rpc.invalid')).toThrow('Network access is disabled in unit tests');
        expect(() => fetch('https://rpc.invalid')).toThrow('Network access is disabled in unit tests');
        expect(process.env.AWS_EC2_METADATA_DISABLED).toBe('true');
    });
});
