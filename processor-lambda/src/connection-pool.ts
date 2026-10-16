import config from 'config';

import { Connection, ConnectionConfig } from '@solana/web3.js';

import { buildRpcUrl, RpcProvider } from './config';
import { escapeHtml } from './telegram/message-generator';
import { sendMessage } from './telegram/telegram';
import { Env, RpcResult } from './types';
import { getErrorObject, shuffleArray, sleep } from './util';

export type ConnectionWrapper = {
    rpcProvider: RpcProvider;
    connection: Connection;
};

export type ConnectionOptions = {
    rpcProvider?: RpcProvider;
    retries?: number;
    retryDelay?: number;
};

const getErrorMessage = (e: unknown): string => String((e as Error)?.message ?? e);

// Bounded, exponentially backed-off retry budget for HTTP 429s (does not consume the caller's `retries`)
const getRateLimitRetryConfig = () => ({
    maxRetries: config.has('rateLimit.connection429.maxRetries')
        ? config.get<number>('rateLimit.connection429.maxRetries')
        : 5,
    baseDelay: config.has('rateLimit.connection429.baseDelay')
        ? config.get<number>('rateLimit.connection429.baseDelay')
        : 250,
    maxDelay: config.has('rateLimit.connection429.maxDelay')
        ? config.get<number>('rateLimit.connection429.maxDelay')
        : 4000,
});

const notifyConnectionError = (env: Env, message: string) => {
    sendMessage(env, escapeHtml(message)).catch((e) =>
        console.log(`Failed to send connection error to Telegram: ${getErrorMessage(e)}`),
    );
};

export class ConnectionPool {
    private currentIndex: number;
    private lastFunctionCalled: string;
    constructor(
        private readonly env: Env,
        public connectionPool: ConnectionWrapper[],
    ) {
        this.currentIndex = 0;
        this.lastFunctionCalled = '';
    }

    static build(env: Env) {
        const connectionConfig: ConnectionConfig = {
            disableRetryOnRateLimit: true,
        };
        let connectionPool = [];

        connectionPool.push({
            rpcProvider: RpcProvider.ALCHEMY,
            connection: new Connection(buildRpcUrl(RpcProvider.ALCHEMY, env.ALCHEMY_RPC_API_KEY)),
        });
        connectionPool.push({
            rpcProvider: RpcProvider.CHAINSTACK,
            connection: new Connection(buildRpcUrl(RpcProvider.CHAINSTACK, env.CHAINSTACK_RPC_API_KEY)),
        });
        connectionPool.push({
            rpcProvider: RpcProvider.SYNDICA,
            connection: new Connection(buildRpcUrl(RpcProvider.SYNDICA, env.SYNDICA_RPC_API_KEY)),
        });
        connectionPool.push({
            rpcProvider: RpcProvider.HELIUS,
            connection: new Connection(buildRpcUrl(RpcProvider.HELIUS, env.HELIUS_RPC_API_KEY)),
        });

        connectionPool = [
            ...connectionPool,
            ...env.HELIUS_RPC_POOL_API_KEYS.map((apiKey: string) => ({
                rpcProvider: RpcProvider.HELIUS,
                connection: new Connection(buildRpcUrl(RpcProvider.HELIUS, apiKey), connectionConfig),
            })),
            ...env.HELLOMOON_RPC_POOL_API_KEYS.map((apiKey: string) => ({
                rpcProvider: RpcProvider.HELLOMOON,
                connection: new Connection(buildRpcUrl(RpcProvider.HELLOMOON, apiKey), connectionConfig),
            })),
            ...env.CHAINSTACK_RPC_POOL_API_KEYS.map((apiKey: string) => ({
                rpcProvider: RpcProvider.CHAINSTACK,
                connection: new Connection(buildRpcUrl(RpcProvider.CHAINSTACK, apiKey), connectionConfig),
            })),
            ...env.ALCHEMY_RPC_POOL_API_KEYS.map((apiKey: string) => ({
                rpcProvider: RpcProvider.ALCHEMY,
                connection: new Connection(buildRpcUrl(RpcProvider.ALCHEMY, apiKey), connectionConfig),
            })),
            ...env.SHYFT_RPC_POOL_API_KEYS.map((apiKey: string) => ({
                rpcProvider: RpcProvider.SHYFT,
                connection: new Connection(buildRpcUrl(RpcProvider.SHYFT, apiKey), connectionConfig),
            })),
        ];

        return new ConnectionPool(env, shuffleArray(connectionPool));
    }

    // Best effort: describes the most recently selected connection, which is not necessarily the one that failed
    getLastConnection(): string {
        const connectionWrapper = this.connectionPool[this.currentIndex];
        return this.getConnectionDescription(this.lastFunctionCalled, connectionWrapper);
    }

    getConnectionDescription(functionCalled: string, connectionWrapper: ConnectionWrapper): string {
        const { rpcProvider, connection } = connectionWrapper;
        return `${rpcProvider.toString()}:${connection.rpcEndpoint.substring(connection.rpcEndpoint.length - 4)}:${functionCalled}`;
    }

    getConnectionWrapper(rpcProvider?: RpcProvider): ConnectionWrapper {
        let connectionWrapper;
        if (rpcProvider) {
            connectionWrapper = this.connectionPool.find(
                (connectionWrapper) => connectionWrapper.rpcProvider === rpcProvider,
            );
            if (!connectionWrapper) {
                throw new Error(`Connection not found for ${rpcProvider}`);
            }
            this.currentIndex = this.connectionPool.indexOf(connectionWrapper);
        } else {
            // Skips the primary connection on first call and always keep the last used connection in state
            this.currentIndex = (this.currentIndex + 1) % this.connectionPool.length;
            connectionWrapper = this.connectionPool[this.currentIndex];
        }
        return connectionWrapper;
    }

    getConnection(rpcProvider?: RpcProvider): Connection {
        return this.getConnectionWrapper(rpcProvider).connection;
    }

    async getConnectionHealth(connection: Connection): Promise<any> {
        const response = await fetch(connection.rpcEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getHealth',
                params: [],
            }),
        });
        if (!response.ok) {
            const data: string = await response.text();
            return data;
        }
        const data: RpcResult<string> = await response.json();
        return data.result as string;
    }

    async execute<T>(
        functionCalled: string,
        callback: (param?: any) => Promise<T>,
        connectionOptions?: ConnectionOptions,
    ): Promise<T> {
        let retries;
        let retryDelay;
        if (connectionOptions) {
            ({ retries, retryDelay } = connectionOptions);
        }
        try {
            console.log(`Calling ${functionCalled}... `);
            const result = await callback();
            return result;
        } catch (e) {
            const connectionErrorDetails = `Connection Error: ${functionCalled} => `;
            console.log(`${connectionErrorDetails}${JSON.stringify(getErrorObject(e, true))}`);
            const rateLimited = getErrorMessage(e).includes('429');
            if (!rateLimited) {
                notifyConnectionError(this.env, `${connectionErrorDetails}${JSON.stringify(getErrorObject(e, true))}`);
            }
            if (retries && retries > 0) {
                if (retryDelay && rateLimited) {
                    await sleep(retryDelay);
                }
                console.log(`Retrying => ${functionCalled}...`);
                return this.execute(functionCalled, callback, {
                    ...connectionOptions,
                    retries: retries - 1,
                });
            }
            throw e;
        }
    }

    async executeWithConnection<T>(
        functionCalled: string,
        callback: (connection: Connection) => Promise<T>,
        connectionOptions?: ConnectionOptions,
        rateLimitAttempt = 0,
    ): Promise<T> {
        let retries;
        let retryDelay;
        let rpcProvider;
        if (connectionOptions) {
            ({ retries, retryDelay, rpcProvider } = connectionOptions);
        }
        const connectionWrapper = this.getConnectionWrapper(rpcProvider);
        try {
            console.log(`Calling ${this.getConnectionDescription(functionCalled, connectionWrapper)}... `);
            this.lastFunctionCalled = functionCalled;
            const result = await callback(connectionWrapper.connection);
            return result;
        } catch (e) {
            const connectionErrorDetails = `Connection Error ${this.getConnectionDescription(functionCalled, connectionWrapper)} => `;
            console.log(`${connectionErrorDetails}${JSON.stringify(getErrorObject(e, true))}`);
            const errorMessage = getErrorMessage(e);
            const rateLimited = errorMessage.includes('429');
            if (!rateLimited && !errorMessage.includes('could not find account')) {
                notifyConnectionError(this.env, `${connectionErrorDetails}${JSON.stringify(getErrorObject(e, true))}`);
            }
            const rateLimitRetry = getRateLimitRetryConfig();
            if (rateLimited && rateLimitAttempt < rateLimitRetry.maxRetries) {
                // Push through 429s on the next connection without using the caller's retries, but bounded and with backoff
                const backoff = Math.min(rateLimitRetry.baseDelay * 2 ** rateLimitAttempt, rateLimitRetry.maxDelay);
                console.log(
                    `Rate limited, retrying in ${backoff}ms (${rateLimitAttempt + 1}/${rateLimitRetry.maxRetries}) => ${functionCalled}...`,
                );
                await sleep(backoff);
                return this.executeWithConnection(functionCalled, callback, connectionOptions, rateLimitAttempt + 1);
            }
            if (retries && retries > 0) {
                if (retryDelay) {
                    await sleep(retryDelay);
                }
                console.log(`Retrying => ${functionCalled}...`);
                return this.executeWithConnection(
                    functionCalled,
                    callback,
                    {
                        ...connectionOptions,
                        retries: retries - 1,
                    },
                    rateLimitAttempt,
                );
            }
            throw e;
        }
    }
}
