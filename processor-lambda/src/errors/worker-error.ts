export enum WorkerErrorType {
    SWAP_NOT_SUPPORTED = 'Swap not currently supported',
    NO_TOKEN_BALANCE = 'No token balance',
    TOKEN_ACCOUNT_NOT_FOUND = 'Token account not found',
    LOW_POOL_LIQUIDITY = 'Low pool liquidity',
    FREEZE_AUTHORITY = 'Freeze authority enabled',
    MINT_AUTHORITY = 'Mint authority enabled',
    MINT_NOT_INITIALIZED = 'Mint not initialized',
    PRICE_NOT_FOUND = 'Price not found',
}

export class WorkerError extends Error {
    constructor(
        public readonly workerErrorType: WorkerErrorType,
        message?: string,
    ) {
        super(message ? `${workerErrorType.toString()}: ${message}` : `${workerErrorType.toString()}`);
        this.name = 'WorkerError';
    }
}
