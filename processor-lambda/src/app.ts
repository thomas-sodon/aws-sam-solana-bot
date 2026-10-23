/**
 * Lambda entry point for the Solana copy-trading bot.
 *
 * Receives Helius enhanced-transaction webhooks (POST /processor), validates the shared
 * auth header, mirrors supported swaps via Jupiter/Raydium and reports progress to Telegram.
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { EnrichedTransaction } from 'helius-sdk';

import { SolanaJSONRPCError } from '@solana/web3.js';

import { TransactionError } from './errors/transaction-error';
import { WorkerError, WorkerErrorType } from './errors/worker-error';
import { handleRequest } from './handler/request-handler';
import { logElapsedTime } from './handler/transaction-handler';
import { claimSignature } from './idempotency';
import { addHyperlink, escapeHtml } from './telegram/message-generator';
import { sendMessage, updateMessage } from './telegram/telegram';
import { SwapProgress } from './types';
import { errorMessage, getErrorObject, redactSecrets, sleep } from './util';
import { WorkerContext } from './worker-context';

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    let requestProcessingResult;
    let response = {
        statusCode: 500,
        body: JSON.stringify({
            message: 'Unexpected error occurred',
        }),
    };
    const wc = await WorkerContext.build();
    let description;
    let messageToSendTransfer = 'This should not be empty';
    let sendMessagePromise;
    let eventBody;
    if (event.body && event.headers.Authorization === wc.env.HELIUS_WEBHOOK_AUTH_HEADER) {
        try {
            const requestBodyArray = JSON.parse(event.body) as EnrichedTransaction[];
            eventBody = requestBodyArray[0];
            ({ description } = eventBody);
            // Claim the leader's signature before trading, so a webhook retry or redelivery is not mirrored twice
            const claim = eventBody.signature ? await claimSignature(eventBody.signature) : 'unguarded';
            if (claim === 'duplicate') {
                console.log(`Duplicate delivery of ${eventBody.signature}, not processing it again`);
                messageToSendTransfer =
                    `${SwapProgress.SWAP_IGNORED.toString()}\n` +
                    `${escapeHtml(description)}\n` +
                    `Duplicate webhook delivery, already handled\n`;
                response = {
                    statusCode: 200,
                    body: JSON.stringify({
                        message: 'Duplicate',
                    }),
                };
            } else {
                sendMessagePromise = sendMessage(
                    wc.env,
                    `${SwapProgress.PROCESSING.toString()}: ${escapeHtml(description)}`,
                ); // Send to Telegram
                requestProcessingResult = await handleRequest(wc, eventBody);
                if (requestProcessingResult.transactionResult?.txSuccess) {
                    messageToSendTransfer =
                        `${requestProcessingResult.messageToSendTransfer}\n` +
                        `${logElapsedTime(requestProcessingResult.transactionResult.elapsedTime, requestProcessingResult.numRetries)}`;
                } else {
                    messageToSendTransfer =
                        `${requestProcessingResult.messageToSendTransfer}\n` +
                        `Retries: ${requestProcessingResult.numRetries}`;
                }
                response = {
                    statusCode: 200,
                    body: JSON.stringify({
                        message: 'Processed',
                        result: requestProcessingResult,
                    }),
                };
            }
        } catch (e) {
            const logError =
                `Last connection: ${wc.connectionPool.getLastConnection()}\n` +
                `${redactSecrets(JSON.stringify(getErrorObject(e), null, 2))}\n`;
            console.log(logError);
            if (
                (e instanceof SolanaJSONRPCError && e.message.includes('could not find account')) ||
                (e instanceof WorkerError && e.workerErrorType === WorkerErrorType.NO_TOKEN_BALANCE)
            ) {
                messageToSendTransfer =
                    `${SwapProgress.SWAP_INVALID.toString()}\n` +
                    `${escapeHtml(description)}\n` +
                    `No token balance found\n`;

                response = {
                    statusCode: 200,
                    body: JSON.stringify({
                        message: 'Processed.',
                    }),
                };
            } else {
                messageToSendTransfer =
                    `${SwapProgress.ERROR.toString()}\n` +
                    `${escapeHtml(description)}\n` +
                    `${escapeHtml(wc.connectionPool.getLastConnection())}\n` +
                    `${escapeHtml((e as Error).name)}\n` +
                    // TransactionError messages already embed generated (escaped) hyperlinks
                    `${e instanceof TransactionError ? e.message : escapeHtml(errorMessage(e))}`;
                if (wc.swapMint?.target) {
                    const dexScreenerLink = addHyperlink(
                        'DexScreener',
                        `https://dexscreener.com/solana/${wc.swapMint.target}`,
                    );
                    messageToSendTransfer = `${messageToSendTransfer}\n${dexScreenerLink}\n`;
                }
                if (wc.swapMint?.input && wc.swapMint.output) {
                    messageToSendTransfer = `${messageToSendTransfer}${addHyperlink('SWAP', TransactionError.buildJupiterSwapLink(wc.swapMint.input, wc.swapMint.output))}\n`;
                }
            }
        } finally {
            if (eventBody) {
                (eventBody as any).instructions = undefined;
                (eventBody as any).nativeTransfers = undefined;
                (eventBody as any).tokenTransfers = undefined;
                console.log(`Event: ${JSON.stringify(eventBody, null, 2)}`);
            }
            if (messageToSendTransfer) {
                console.log(`Message Sent: ${JSON.stringify(messageToSendTransfer, null, 2)}`);
            }

            if (sendMessagePromise) {
                const sendMessageResponse = await sendMessagePromise;
                if (sendMessageResponse.ok) {
                    await updateMessage(wc, messageToSendTransfer, sendMessageResponse.result); // Send to Telegram
                    return response;
                }
            }
            await sendMessage(wc.env, messageToSendTransfer); // Send to Telegram anyway
            await sleep(50); // Let message settle
        }
    } else {
        response = {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Not processed',
            }),
        };
    }
    return response;
};
