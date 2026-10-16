/**
 * Jest setup for the unit suite: makes any accidental network access fail loudly instead of
 * reaching AWS, Solana RPC, Jupiter, Telegram, DexScreener or Helius.
 */
import net from 'net';
import tls from 'tls';

process.env.AWS_EC2_METADATA_DISABLED = 'true';
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;
delete process.env.AWS_SESSION_TOKEN;
delete process.env.AWS_PROFILE;

const blocked = (what: string) => () => {
    throw new Error(`Network access is disabled in unit tests (${what}); mock the dependency instead`);
};

net.Socket.prototype.connect = blocked('net.Socket.connect') as unknown as typeof net.Socket.prototype.connect;
tls.connect = blocked('tls.connect') as unknown as typeof tls.connect;
globalThis.fetch = blocked('fetch') as unknown as typeof fetch;

// The source logs every step; keep test output readable unless explicitly debugging
if (process.env.DEBUG_TESTS !== '1') {
    console.log = () => undefined;
}
