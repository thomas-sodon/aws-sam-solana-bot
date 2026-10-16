export enum JupiterErrorType {
    QUOTE_FAIL = 'Failed to obtain quote',
    SWAP_TRANSACTION_FAIL = 'Failed to get the swap transaction for provided quote',
    TOKEN_NOT_TRADABLE = 'Token is not tradable',
}

export class JupiterError extends Error {
    constructor(
        public readonly jupiterErrorType: JupiterErrorType,
        message?: string,
    ) {
        super(message ? `${jupiterErrorType.toString()}: ${message}` : `${jupiterErrorType.toString()}`);
        this.name = 'JupiterError';
    }
}
