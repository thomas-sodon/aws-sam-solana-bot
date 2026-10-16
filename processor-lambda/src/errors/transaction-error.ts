import { PublicKey } from '@solana/web3.js';

import { TransactionInputs } from '../types';

export enum TransactionErrorType {
    SLIPPAGE = 'Slippage occurred',
    BLOCKHASH_EXPIRED = 'Blockhash expired',
    ACCOUNT_FROZEN = 'Account frozen',
    SIMULATION_FAILED = 'Simulation failed',
}

export type TransactionErrorLoggingDetails = {
    startTime: Date;
    transactionInputs: TransactionInputs;
    numRetries: number;
};

export class TransactionError extends Error {
    constructor(
        public readonly transactionErrorType: TransactionErrorType,
        public readonly transactionInputs: TransactionInputs,
        public elapsedTime: number,
        message?: string,
    ) {
        super(
            message
                ? `${transactionErrorType.toString()}: ${message}\n${TransactionError.buildJupiterSwapLink(transactionInputs.inputTokenAmount.token.mint, transactionInputs.outputToken.mint)}`
                : `${transactionErrorType.toString()}\n${TransactionError.buildJupiterSwapLink(transactionInputs.inputTokenAmount.token.mint, transactionInputs.outputToken.mint)}`,
        );
        this.name = 'TransactionError';
    }

    static buildJupiterSwapLink(inputMint: PublicKey, outputMint: PublicKey) {
        return `https://jup.ag/swap/${inputMint.toString()}-${outputMint.toString()}`;
    }
}
