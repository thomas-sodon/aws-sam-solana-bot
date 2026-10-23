import bs58 from 'bs58';
import config from 'config';

import { Connection, Keypair, SignatureStatus, VersionedTransaction } from '@solana/web3.js';

import { ConnectionOptions } from '../connection-pool';
import { TransactionError, TransactionErrorLoggingDetails, TransactionErrorType } from '../errors/transaction-error';
import { addHyperlink, escapeHtml } from '../telegram/message-generator';
import { SigningResult, TransactionResult } from '../types';
import { errorMessage, getElapsedTime } from '../util';
import { WorkerContext } from '../worker-context';

export const signTransaction = (
    wallet: Keypair,
    transaction: VersionedTransaction,
    lastValidBlockHeight: number,
): SigningResult => {
    // sign the transaction
    transaction.sign([wallet]);
    return {
        versionedTransaction: transaction,
        rawTransaction: transaction.serialize(),
        signature: bs58.encode(transaction.signatures[0]),
        lastValidBlockHeight,
    };
};

export const executeTransaction = async (
    wc: WorkerContext,
    signingResult: SigningResult,
    loggingDetails: TransactionErrorLoggingDetails,
): Promise<TransactionResult> => {
    const connectionOptions = config.get<ConnectionOptions>('connectionOptions.executeTransaction');
    const { rawTransaction, lastValidBlockHeight, signature } = signingResult;
    let blockheight = await wc
        .getConnectionPool()
        .executeWithConnection(
            'getBlockHeight',
            (connection: Connection) => connection.getBlockHeight(),
            connectionOptions,
        );
    let transactionResult: TransactionResult = {
        txSuccess: false,
        status: null,
        elapsedTime: 0,
        signature,
    };

    let toggleCheckSignatureStatus = true;
    while (blockheight < lastValidBlockHeight) {
        for (let i = 0; i < 3; i++) {
            wc.getConnectionPool()
                .executeWithConnection(
                    'sendRawTransaction',
                    (connection: Connection) =>
                        connection.sendRawTransaction(rawTransaction, {
                            skipPreflight: true,
                            maxRetries: config.has('maxRetries') ? config.get('maxRetries') : undefined,
                        }),
                    connectionOptions,
                )
                .catch((e) => {
                    console.log(`sendRawTransaction${i} error: ${errorMessage(e)}`);
                });
        }
        if (toggleCheckSignatureStatus) {
            transactionResult = await checkSignatureStatus(wc, signature, loggingDetails);
            if (transactionResult.txSuccess) {
                return transactionResult;
            }
            toggleCheckSignatureStatus = false;
        } else {
            toggleCheckSignatureStatus = true;
        }

        console.log(`blockHeight diff: ${lastValidBlockHeight - blockheight}`);
        blockheight = await wc
            .getConnectionPool()
            .executeWithConnection(
                'getBlockHeight',
                (connection: Connection) => connection.getBlockHeight(),
                connectionOptions,
            );
        console.log(`blockHeight: ${blockheight}`);
    }

    return transactionResult;
};

/**
 * Dry-run mode (ENABLE_EXECUTION=false): simulates the signed transaction once and reports
 * success from the simulation result. Simulated transactions are never broadcast, so there is
 * no signature status to poll. The caller reports a success as SWAP NOT EXECUTED and treats a
 * failure as final (no retry).
 */
export const executeSimulation = async (
    wc: WorkerContext,
    signingResult: SigningResult,
    loggingDetails: TransactionErrorLoggingDetails,
): Promise<TransactionResult> => {
    const { versionedTransaction, signature } = signingResult;
    const { value } = await wc
        .getConnectionPool()
        .executeWithConnection('simulateTransaction', (connection: Connection) =>
            connection.simulateTransaction(versionedTransaction),
        );
    if (value.logs) {
        console.log(`Simulation logs for ${signature}:\n${value.logs.join('\n')}`);
    }
    const txSuccess = !value.err;
    if (!txSuccess) {
        console.log(`Simulation failed for ${signature}: ${JSON.stringify(value.err)}`);
    }
    return {
        txSuccess,
        elapsedTime: getElapsedTime(loggingDetails.startTime),
        status: null,
        signature,
    };
};

export const logElapsedTime = (
    elapsedTime: number,
    numRetries: number,
    signature?: string,
    status?: SignatureStatus,
) => {
    const elapsedText = `Elapsed time: ${elapsedTime} seconds over ${numRetries} retries`;
    const forSignature = signature ? ` for ${addHyperlink(signature, `https://solscan.io/tx/${signature}`)}` : '';
    const forStatus = status ? ` with status (${escapeHtml(JSON.stringify(status, null, 2))})` : '';
    return `${elapsedText}${forSignature}${forStatus}`;
};

export const checkSignatureStatus = async (
    wc: WorkerContext,
    signature: string,
    loggingDetails: TransactionErrorLoggingDetails,
): Promise<TransactionResult> => {
    const connectionOptions = config.get<ConnectionOptions>('connectionOptions.executeTransaction');
    const { value: status } = await wc
        .getConnectionPool()
        .executeWithConnection(
            'getSignatureStatus',
            (connection: Connection) => connection.getSignatureStatus(signature),
            connectionOptions,
        );
    const { startTime, transactionInputs, numRetries } = loggingDetails;
    let txSuccess = false;
    const elapsedTime = getElapsedTime(startTime);
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
        txSuccess = true;
        const someError = status.err as any;
        if (someError) {
            if (
                someError.InstructionError &&
                Array.isArray(someError.InstructionError) &&
                someError.InstructionError.length >= 2 &&
                someError.InstructionError[1].Custom === 6001
            ) {
                throw new TransactionError(
                    TransactionErrorType.SLIPPAGE,
                    transactionInputs,
                    elapsedTime,
                    `${logElapsedTime(elapsedTime, numRetries, signature, status)}`,
                );
            } else if (
                someError.InstructionError &&
                Array.isArray(someError.InstructionError) &&
                someError.InstructionError.length >= 2 &&
                someError.InstructionError[1].Custom === 17
            ) {
                throw new TransactionError(
                    TransactionErrorType.ACCOUNT_FROZEN,
                    transactionInputs,
                    elapsedTime,
                    `${logElapsedTime(elapsedTime, numRetries, signature, status)}`,
                );
            }
            throw new TransactionError(
                TransactionErrorType.BLOCKHASH_EXPIRED,
                transactionInputs,
                elapsedTime,
                `${logElapsedTime(elapsedTime, numRetries, signature, status)}`,
            );
        }
        console.log(`Transaction succeeded! ${logElapsedTime(elapsedTime, numRetries, signature, status)}`);
    } else if (status) {
        console.log(`Interim status for ${signature}: ${JSON.stringify(status, null, 2)}`);
    }
    return { txSuccess, elapsedTime, status, signature };
};
