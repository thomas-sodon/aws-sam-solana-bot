import config from 'config';
import fetch from 'node-fetch';

import { QuoteResponse, SwapResponse } from '@jup-ag/api';
import { Keypair, VersionedTransaction } from '@solana/web3.js';

import { buildQuicknodeJupiterSwapBasePath } from '../config';
import { JupiterError, JupiterErrorType } from '../errors/jupiter-error';
import { SwapTransaction, TransactionInputs } from '../types';
import { WorkerContext } from '../worker-context';

export async function buildJupiterSwapTransaction(
    wc: WorkerContext,
    payer: Keypair,
    transactionInputs: TransactionInputs,
    prioritizationFeeLamports: number | string,
): Promise<SwapTransaction> {
    console.log(`Perform Jupiter swap...`);
    const basePath = buildQuicknodeJupiterSwapBasePath(wc.env.QUICKNODE_JUPITER_API_KEY);
    const jupiterPublicPath = config.get<string>('jupiter.publicPath');

    const { inputTokenAmount, outputToken } = transactionInputs;
    let quoteResponse;

    try {
        quoteResponse = await getJupiterQuoteByUrl(
            jupiterPublicPath,
            inputTokenAmount.token.mint.toString(),
            outputToken.mint.toString(),
            inputTokenAmount.raw.toString(10),
        );
    } catch (e) {
        console.log('getJupiterQuoteByUrl error', e);
    }

    if (checkResponseForError(quoteResponse)) {
        quoteResponse = await getJupiterQuoteByUrl(
            basePath,
            inputTokenAmount.token.mint.toString(),
            outputToken.mint.toString(),
            inputTokenAmount.raw.toString(10),
        );
        if (checkResponseForError(quoteResponse)) {
            if ((quoteResponse as any).errorCode === 'TOKEN_NOT_TRADABLE') {
                throw new JupiterError(JupiterErrorType.TOKEN_NOT_TRADABLE, `${(quoteResponse as any).error}`);
            }
            throw new JupiterError(JupiterErrorType.QUOTE_FAIL, `${(quoteResponse as any).error}`);
        }
    }

    if (!quoteResponse) {
        throw new Error('Jupiter quoteResponse is undefined');
    }

    let swapResponse = await getJupiterSwapTransactionByUrl(
        jupiterPublicPath,
        payer,
        quoteResponse,
        prioritizationFeeLamports,
    );
    if (checkResponseForError(swapResponse)) {
        swapResponse = await getJupiterSwapTransactionByUrl(basePath, payer, quoteResponse, prioritizationFeeLamports);
    }
    if (!swapResponse || checkResponseForError(swapResponse)) {
        throw new JupiterError(JupiterErrorType.SWAP_TRANSACTION_FAIL, `${(swapResponse as any)?.error}`);
    }
    if (typeof swapResponse === 'string') {
        throw new JupiterError(JupiterErrorType.SWAP_TRANSACTION_FAIL, `${swapResponse}`);
    }
    // deserialize the transaction
    return {
        versionedTransaction: VersionedTransaction.deserialize(Buffer.from(swapResponse.swapTransaction, 'base64')),
        prioritizationFeeLamports: swapResponse.prioritizationFeeLamports,
        lastValidBlockHeight: swapResponse.lastValidBlockHeight,
    };
}

const buildJupiterQuoteUrl = (basePath: string, inputMint: string, outputMint: string, amount: string) =>
    `${basePath}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&computeAutoSlippage=true`;

const checkResponseForError = (response: any) => {
    return (response && (response as any).error) || !response;
};

const getJupiterQuoteByUrl = async (
    basePath: string,
    inputMint: string,
    outputMint: string,
    amount: string,
): Promise<QuoteResponse> => {
    const jupiterQuoteUrl = buildJupiterQuoteUrl(basePath, inputMint, outputMint, amount);
    const quoteResponse = (await (await fetch(jupiterQuoteUrl)).json()) as QuoteResponse;
    return quoteResponse;
};

const getJupiterSwapTransactionByUrl = async (
    basePath: string,
    payer: Keypair,
    quoteResponse: QuoteResponse,
    prioritizationFeeLamports: number | string,
): Promise<SwapResponse> => {
    const body = JSON.stringify({
        // quoteResponse from /quote api
        quoteResponse,
        // user public key to be used for the swap
        userPublicKey: payer.publicKey.toString(),
        prioritizationFeeLamports,
        dynamicComputeUnitLimit: config.get<boolean>('jupiter.dynamicComputeUnitLimit'),
        // feeAccount is optional. Use if you want to charge a fee.  feeBps must have been passed in /quote API.
        // feeAccount: "fee_account_public_key"
    });

    const swapResponseRaw = await fetch(`${basePath}/swap`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body,
    });
    // Read the body once: a non-JSON error page would otherwise be lost to "body used already"
    const swapResponseText = await swapResponseRaw.text();
    try {
        return JSON.parse(swapResponseText) as SwapResponse;
    } catch (e) {
        throw new JupiterError(
            JupiterErrorType.SWAP_TRANSACTION_FAIL,
            `${swapResponseRaw.status}: ${swapResponseText}`,
        );
    }
};
