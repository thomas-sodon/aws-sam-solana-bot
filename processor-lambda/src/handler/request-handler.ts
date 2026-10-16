import { EnrichedTransaction, TransactionType } from 'helius-sdk';

import { castProcessingResult, RequestProcessingResult, SwapProgress } from '../types';
import { escapeHtml } from '../telegram/message-generator';
import { WorkerContext } from '../worker-context';
import { processSwapEvent } from './swap-handler';

export const handleRequest = async (
    wc: WorkerContext,
    eventBody: EnrichedTransaction,
): Promise<RequestProcessingResult> => {
    let requestProcessingResult: RequestProcessingResult = {
        messageToSendTransfer: `${SwapProgress.ERROR.toString()}\n` + `Request error\n`,
        transactionInputs: undefined,
        transactionResult: undefined,
        numRetries: 0,
        swapProvider: undefined,
    };
    const { type, events, source } = eventBody;
    if (type === TransactionType.SWAP && events) {
        const { swap: swapEvent } = events;
        if (swapEvent) {
            requestProcessingResult = castProcessingResult(await processSwapEvent(wc, source, swapEvent, eventBody));
        } else {
            requestProcessingResult.messageToSendTransfer =
                `${SwapProgress.ERROR.toString()}\n` + `Swap event not found\n`;
        }
    } else {
        const requestJson = JSON.stringify(eventBody, null, 2);
        const ignoredMessage = `${SwapProgress.IGNORED.toString()}\n` + `${escapeHtml(requestJson)}\n`;
        requestProcessingResult.messageToSendTransfer = `${ignoredMessage}`;
    }
    return requestProcessingResult;
};
