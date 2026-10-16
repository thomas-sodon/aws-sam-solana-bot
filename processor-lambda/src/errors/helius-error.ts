export enum HeliusErrorType {
    PRIORITY_FEE_FAIL = 'Failed to obtain priority fee',
}

export class HeliusError extends Error {
    constructor(
        public readonly heliusErrorType: HeliusErrorType,
        message?: string,
    ) {
        super(message ? `${heliusErrorType.toString()}: ${message}` : `${heliusErrorType.toString()}`);
        this.name = 'HeliusError';
    }
}
