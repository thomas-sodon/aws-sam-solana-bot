import { Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { PublicKey, SignatureStatus, VersionedTransaction } from '@solana/web3.js';

export enum SwapProgress {
    SUCCESS = '\u{1F7E2} ----SWAP SUCCESS---',
    NOT_EXECUTED = `\u{1F7E0} ----SWAP NOT EXECUTED---`,
    ERROR = `\u{1F534} ----SWAP ERROR---`,
    IGNORED = `\u{25CB} ----MESSAGE IGNORED---`,
    SWAP_INVALID = `\u{1F7E1} ----SWAP INVALID---`,
    SWAP_IGNORED = `\u{1F7E3} ----SWAP IGNORED---`,
    PROCESSING = `\u{1F535} Processing`,
}

export interface Env {
    ENABLE_EXECUTION: boolean;
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_CHAT_ID: number;
    WALLET_PRIVATE_KEY: string;
    HELIUS_WEBHOOK_AUTH_HEADER: string;
    QUICKNODE_JUPITER_API_KEY: string;
    ALCHEMY_RPC_API_KEY: string;
    CHAINSTACK_RPC_API_KEY: string;
    SYNDICA_RPC_API_KEY: string;
    HELIUS_RPC_API_KEY: string;
    HELLOMOON_RPC_POOL_API_KEYS: string[];
    HELIUS_RPC_POOL_API_KEYS: string[];
    CHAINSTACK_RPC_POOL_API_KEYS: string[];
    ALCHEMY_RPC_POOL_API_KEYS: string[];
    SHYFT_RPC_POOL_API_KEYS: string[];
    SKIP_LIQUIDITY_CHECK: string[];
}

export type nullish = null | undefined;

export type TransactionInputs = {
    inputTokenAmount: TokenAmount;
    outputToken: Token;
    targetMint: PublicKey;
};

export enum SwapProvider {
    JUPITER = 'Jupiter',
    RAYDIUM = 'Raydium',
}

export type EventProcessingResult = {
    transactionResult: TransactionResult;
    transactionInputs?: TransactionInputs;
    messageToSendTransfer: string;
    numRetries: number;
    swapProvider: SwapProvider;
};

export type RequestProcessingResult = {
    transactionResult: TransactionResult | nullish;
    transactionInputs: TransactionInputs | nullish;
    messageToSendTransfer: string;
    numRetries: number;
    swapProvider: SwapProvider | nullish;
};

export type RpcResult<T> = {
    jsonrpc: number;
    result: T;
    id: string;
};

export const castProcessingResult = (eventProcessingResult: EventProcessingResult): RequestProcessingResult => {
    return {
        transactionInputs: eventProcessingResult.transactionInputs,
        messageToSendTransfer: eventProcessingResult.messageToSendTransfer,
        transactionResult: eventProcessingResult.transactionResult,
        numRetries: eventProcessingResult.numRetries,
        swapProvider: eventProcessingResult.swapProvider,
    };
};

export type SigningResult = {
    versionedTransaction: VersionedTransaction;
    rawTransaction: Uint8Array;
    signature: string;
    lastValidBlockHeight: number;
};

export type TransactionResult = {
    txSuccess: boolean;
    elapsedTime: number;
    status: SignatureStatus | null;
    signature: string;
};

export type SwapTransaction = {
    versionedTransaction: VersionedTransaction;
    lastValidBlockHeight: number;
    prioritizationFeeLamports?: number;
};

export enum HeliusPriorityLevel {
    LOW = 'Low',
    MEDIUM = 'Medium',
    HIGH = 'High',
}
