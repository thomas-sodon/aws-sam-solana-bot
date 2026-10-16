import { Keypair, PublicKey } from '@solana/web3.js';

import { buildEnv } from './config';
import { ConnectionPool } from './connection-pool';
import { Env } from './types';
import { buildWallet } from './wallet';

export type SwapMintDetails = {
    input: PublicKey;
    output: PublicKey;
    target: PublicKey;
};

export class WorkerContext {
    public swapMint: SwapMintDetails | undefined;

    constructor(
        public readonly env: Env,
        public readonly wallet: Keypair,
        public readonly connectionPool: ConnectionPool,
    ) {}

    static async build(): Promise<WorkerContext> {
        console.log(`Initializing WorkerContext...`);
        const env = await buildEnv();
        const wallet = buildWallet(env.WALLET_PRIVATE_KEY);
        const workerContext = new WorkerContext(env, wallet, ConnectionPool.build(env));
        console.log(`WorkerContext initialized`);
        return workerContext;
    }

    getConnectionPool(): ConnectionPool {
        return this.connectionPool;
    }
}
