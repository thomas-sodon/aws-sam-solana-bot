import config from 'config';
import { EnrichedTransaction, SwapEvent } from 'helius-sdk';

import { Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { PublicKey } from '@solana/web3.js';

import { DEFAULT_TOKEN, newSplToken } from '../config';
import { JupiterError, JupiterErrorType } from '../errors/jupiter-error';
import { TransactionError, TransactionErrorType } from '../errors/transaction-error';
import { WorkerError, WorkerErrorType } from '../errors/worker-error';
import { getPriorityFeeEstimateByMint } from '../helius';
import { buildJupiterSwapTransaction } from '../jupiter';
import { getMintInfo, getPoolInfo } from '../pool-info';
import { buildRaydiumSwapTransaction } from '../raydium';
import { addHyperlink, escapeHtml } from '../telegram/message-generator';
import {
    EventProcessingResult,
    HeliusPriorityLevel,
    SwapProgress,
    SwapProvider,
    TransactionInputs,
    TransactionResult,
} from '../types';
import { describeError, getElapsedTime, redactSecrets, sleep } from '../util';
import { getWalletTokenAmount } from '../wallet';
import { WorkerContext } from '../worker-context';
import { executeSimulation, executeTransaction, logElapsedTime, signTransaction } from './transaction-handler';

export const processSwapEvent = async (
    wc: WorkerContext,
    source: string,
    swapEvent: SwapEvent,
    requestBody: EnrichedTransaction,
): Promise<EventProcessingResult> => {
    const { description, feePayer } = requestBody;
    console.log(`Processing Swap Event: ${description}`);

    const checkPoolLiquidity = isBaseInput(swapEvent) && !wc.env.SKIP_LIQUIDITY_CHECK.includes(feePayer);
    const { transactionResult, numRetries, swapProvider, transactionInputs } = await executeSwap(wc, swapEvent, {
        checkPoolLiquidity,
    });

    let messageToSendTransfer;
    if (transactionResult?.txSuccess && transactionInputs) {
        const { targetMint } = transactionInputs;
        const rugcheckLink = addHyperlink('Rugcheck', `https://rugcheck.xyz/tokens/${targetMint}`);
        const dexScreenerLink = addHyperlink('DexScreener', `https://dexscreener.com/solana/${targetMint}`);
        const dexCheckLink = addHyperlink('DexCheck', `https://dexcheck.ai/app/wallet-analyzer/${targetMint}`);
        // In dry-run mode the signature was only simulated, never broadcast, so there is nothing to link to
        const executed = wc.env.ENABLE_EXECUTION;
        const solscanLink = executed
            ? `${addHyperlink('Solscan', `https://solscan.io/tx/${transactionResult.signature}`)} `
            : '';
        const traderLink = addHyperlink(feePayer, `https://birdeye.so/profile/${feePayer}?chain=solana`);
        const splitDescription = description.split('swapped');
        const swapProviderLink = addHyperlink(
            swapProvider.toString(),
            TransactionError.buildJupiterSwapLink(
                transactionInputs.inputTokenAmount.token.mint,
                transactionInputs.outputToken.mint,
            ),
        );
        messageToSendTransfer =
            `${(executed ? SwapProgress.SUCCESS : SwapProgress.NOT_EXECUTED).toString()}\n` +
            (executed ? '' : 'Dry run: simulated successfully, not broadcast\n') +
            `${traderLink} swapped\n` +
            `${escapeHtml(splitDescription[1])}\n` +
            `${solscanLink}` +
            `${rugcheckLink} ` +
            `${dexCheckLink} ` +
            `${dexScreenerLink}\n` +
            `${swapProviderLink}`;
    } else {
        console.log(`Swap ignored: ${description}`);
        messageToSendTransfer = `${SwapProgress.IGNORED.toString()}\nSource: ${escapeHtml(source)}\n`;
        if (!description) {
            messageToSendTransfer += `${escapeHtml(JSON.stringify(requestBody, null, 2))}`;
        } else {
            messageToSendTransfer += `${escapeHtml(description)}\n`;
        }
    }
    return { transactionResult, transactionInputs, messageToSendTransfer, numRetries, swapProvider };
};

const executeSwap = async (
    wc: WorkerContext,
    swapEvent: SwapEvent,
    swapOptions: { checkPoolLiquidity?: boolean } = { checkPoolLiquidity: true },
): Promise<{
    transactionResult: TransactionResult;
    numRetries: number;
    swapProvider: SwapProvider;
    transactionInputs?: TransactionInputs;
}> => {
    const { env, wallet } = wc;
    let swapTransaction;
    let swapSuccess;
    let transactionInputs: TransactionInputs | undefined;
    const MAX_NUM_RETRIES = 6;
    let numRetries = 0;
    let transactionResult: TransactionResult = {
        txSuccess: false,
        status: null,
        elapsedTime: 0,
        signature: 'notexecuted',
    };
    let swapProvider = SwapProvider.JUPITER;
    let poolInfo;
    const { inputToken, outputToken, targetMint } = extractInputOutputTokens(swapEvent);
    // Store this off to global context for later use
    wc.swapMint = { input: inputToken.mint, output: outputToken.mint, target: targetMint };

    /**
     * Find mint information for the given token and check if safe to trade
     */
    await getMintInfo(wc.connectionPool, targetMint);
    while (swapSuccess !== true && numRetries <= MAX_NUM_RETRIES) {
        try {
            /**
             * Find pool information for the given token pair if not already found
             */
            if (!poolInfo) {
                poolInfo = await getPoolInfo(wc, targetMint, swapOptions.checkPoolLiquidity);
            }
            console.log(`Found and cleared pool info: ${JSON.stringify(poolInfo, null, 2)}`);

            /**
             * Find transaction input amount if not already obtained
             */
            if (!transactionInputs) {
                const inputTokenAmount = await extractInputTokenAmount(wc, swapEvent, inputToken);
                transactionInputs = { inputTokenAmount, outputToken, targetMint };
            }
            let prioritizationFeeLamports: number | string | undefined;
            const maxPrioritizationFeeLamports = config.get<number>('maxPrioritizationFeeLamports');
            try {
                prioritizationFeeLamports = await getPriorityFeeEstimateByMint(
                    wc,
                    targetMint,
                    config.get<HeliusPriorityLevel>('heliusPriorityFeelevel'),
                );
                if (prioritizationFeeLamports > maxPrioritizationFeeLamports) {
                    prioritizationFeeLamports = await getPriorityFeeEstimateByMint(
                        wc,
                        targetMint,
                        HeliusPriorityLevel.LOW,
                    );
                }
                if (prioritizationFeeLamports > maxPrioritizationFeeLamports) {
                    prioritizationFeeLamports = undefined;
                }
            } catch (e) {
                console.log(`Priority fee estimate unavailable, using configured default: ${describeError(e, true)}`);
            }
            switch (swapProvider) {
                case SwapProvider.JUPITER:
                    if (!prioritizationFeeLamports) {
                        prioritizationFeeLamports = config.get<string>('jupiter.prioritizationFeeLamports');
                    }
                    swapTransaction = await buildJupiterSwapTransaction(
                        wc,
                        wallet,
                        transactionInputs,
                        prioritizationFeeLamports,
                    );
                    console.log(
                        `prioritizationFeeLamports: ${prioritizationFeeLamports ?? swapTransaction.prioritizationFeeLamports}`,
                    );
                    break;
                case SwapProvider.RAYDIUM:
                    // Raydium takes a compute-unit price (micro-lamports per CU), the same unit Helius estimates in
                    prioritizationFeeLamports =
                        prioritizationFeeLamports ?? config.get<number>('raydium.computeUnitPriceMicroLamports');
                    console.log(`computeUnitPriceMicroLamports: ${prioritizationFeeLamports}`);
                    swapTransaction = await buildRaydiumSwapTransaction(
                        wc,
                        transactionInputs,
                        poolInfo,
                        prioritizationFeeLamports as number | undefined,
                    );
                    break;
            }

            if (swapTransaction) {
                const { versionedTransaction, lastValidBlockHeight } = swapTransaction;
                const signingResult = signTransaction(wallet, versionedTransaction, lastValidBlockHeight);
                transactionResult.signature = signingResult.signature;
                let newTransactionResult;
                const startTime = new Date();
                if (env.ENABLE_EXECUTION === true) {
                    newTransactionResult = await executeTransaction(wc, signingResult, {
                        startTime,
                        transactionInputs,
                        numRetries,
                    });
                } else {
                    newTransactionResult = await executeSimulation(wc, signingResult, {
                        startTime,
                        transactionInputs,
                        numRetries,
                    });
                }
                if (!newTransactionResult.txSuccess && env.ENABLE_EXECUTION !== true) {
                    // A failed simulation will fail the same way again, so report it without retrying
                    throw new TransactionError(
                        TransactionErrorType.SIMULATION_FAILED,
                        transactionInputs,
                        getElapsedTime(startTime),
                        logElapsedTime(getElapsedTime(startTime), numRetries),
                    );
                }
                if (!newTransactionResult.txSuccess) {
                    const elapsedTime = getElapsedTime(startTime);
                    throw new TransactionError(
                        TransactionErrorType.BLOCKHASH_EXPIRED,
                        transactionInputs,
                        elapsedTime,
                        `${logElapsedTime(elapsedTime, numRetries, signingResult.signature)}`,
                    );
                }
                const elapsedTime = newTransactionResult.elapsedTime;
                const totalElapsedTime = transactionResult.elapsedTime + elapsedTime;
                transactionResult = newTransactionResult;
                transactionResult.elapsedTime = totalElapsedTime;
                break;
            }
        } catch (e) {
            console.log(`Failed to executeSwap: ${describeError(e)}`);
            if (e instanceof TransactionError && e.transactionErrorType === TransactionErrorType.SIMULATION_FAILED) {
                e.elapsedTime = transactionResult.elapsedTime + e.elapsedTime;
                throw e;
            }
            if ((e instanceof TransactionError || e instanceof JupiterError) && numRetries >= MAX_NUM_RETRIES) {
                if (e instanceof TransactionError) {
                    e.elapsedTime = transactionResult.elapsedTime + e.elapsedTime;
                }
                console.log(`Transaction failed after ${MAX_NUM_RETRIES} attempts: ${redactSecrets(e.message)}`);
                throw e;
            } else if (e instanceof TransactionError && numRetries <= MAX_NUM_RETRIES) {
                transactionResult.elapsedTime = transactionResult.elapsedTime + e.elapsedTime;
            } else if (!(e instanceof TransactionError || e instanceof JupiterError)) {
                // Shouldn't retry on these errors
                if (
                    e instanceof WorkerError &&
                    (e.workerErrorType === WorkerErrorType.LOW_POOL_LIQUIDITY ||
                        e.workerErrorType === WorkerErrorType.FREEZE_AUTHORITY ||
                        e.workerErrorType === WorkerErrorType.MINT_AUTHORITY)
                ) {
                    throw e;
                }
                // Wait to see if token balance shows
                if (
                    e instanceof WorkerError &&
                    (e.workerErrorType === WorkerErrorType.NO_TOKEN_BALANCE ||
                        e.workerErrorType === WorkerErrorType.TOKEN_ACCOUNT_NOT_FOUND)
                ) {
                    // Should wait for token balance in the first call, don't retry
                    throw e;
                }
                if (numRetries >= 3) {
                    throw e;
                }
            } else if (e instanceof JupiterError && e.jupiterErrorType === JupiterErrorType.TOKEN_NOT_TRADABLE) {
                swapProvider = SwapProvider.RAYDIUM;
                numRetries += 1;
                continue;
            }
        }
        console.log(`Attempt ${numRetries} failed. Retrying...`);
        numRetries += 1;
        await sleep(config.get<number>('rateLimit.executeSwapRetry'));
    }
    return { transactionResult, numRetries, swapProvider, transactionInputs };
};

export const isStableMint = (mint?: string): boolean =>
    mint === DEFAULT_TOKEN.USDC.mint.toString() || mint === DEFAULT_TOKEN.USDT.mint.toString();
export const isBaseInput = (swapEvent: SwapEvent): boolean =>
    !!swapEvent.nativeInput || isStableMint(swapEvent.tokenInputs?.[0]?.mint);
export const isBaseToSplSwap = (swapEvent: SwapEvent) => isBaseInput(swapEvent) && swapEvent.tokenOutputs.length > 0;
export const isSplToBaseSwap = (swapEvent: SwapEvent) =>
    (!!swapEvent.nativeOutput || isStableMint(swapEvent.tokenOutputs?.[0]?.mint)) && swapEvent.tokenInputs.length > 0;

export const extractInputTokenAmount = async (
    wc: WorkerContext,
    swapEvent: SwapEvent,
    inputToken: Token,
): Promise<TokenAmount> => {
    console.log('extractInputTokenAmount');
    const { nativeInput, tokenInputs, tokenOutputs } = swapEvent;
    let inputTokenAmount: TokenAmount | undefined;
    let tokenMint: PublicKey | undefined;
    if (isBaseToSplSwap(swapEvent)) {
        console.log('isBaseToSplSwap');
        const maxSolBuy = config.get<number>('max.buy.sol');
        // Buys are always mirrored with WSOL: SOL inputs are capped at max.buy.sol,
        // stablecoin (USDC/USDT) inputs are copied as a max.buy.sol sized buy.
        const amount = nativeInput && nativeInput.amount <= maxSolBuy ? nativeInput.amount : maxSolBuy;
        tokenMint = new PublicKey(tokenOutputs[0].mint);
        inputTokenAmount = new TokenAmount(DEFAULT_TOKEN.WSOL, amount);
    } else if (isSplToBaseSwap(swapEvent)) {
        console.log('isSplToBaseSwap');
        tokenMint = new PublicKey(tokenInputs[0].mint);
        // Obtain token balance from the wallet
        inputTokenAmount = await getWalletTokenAmount(wc, tokenMint, wc.wallet.publicKey);
        const isUSDC = inputTokenAmount.token.mint.toString() === DEFAULT_TOKEN.USDC.mint.toString();
        const isLessThanMax = parseInt(tokenInputs[0].rawTokenAmount.tokenAmount) < config.get<number>('max.buy.usdc');
        console.log(`isUSDC: ${isUSDC}, isLessThanMax: ${isLessThanMax}`);
        if (isUSDC && isLessThanMax) {
            console.log('USDC input amount less than max');
            inputTokenAmount = new TokenAmount(DEFAULT_TOKEN.USDC, tokenInputs[0].rawTokenAmount.tokenAmount);
        }
    } else {
        throw new WorkerError(WorkerErrorType.SWAP_NOT_SUPPORTED, `Swap not currently supported`);
    }
    if (!inputTokenAmount || inputTokenAmount.raw.toString(10) === '0') {
        throw new WorkerError(WorkerErrorType.NO_TOKEN_BALANCE, `Token balance not found for ${tokenMint.toString()}`);
    }
    if (inputToken.mint.toString() !== inputTokenAmount.token.mint.toString()) {
        throw new Error(`Token mismatch: ${inputToken.mint.toString()} !== ${inputTokenAmount.token.mint.toString()}`);
    }
    return inputTokenAmount;
};

export const extractInputOutputTokens = (
    swapEvent: SwapEvent,
): { inputToken: Token; outputToken: Token; targetMint: PublicKey } => {
    const { tokenInputs, tokenOutputs } = swapEvent;
    let inputToken: Token | undefined;
    let outputToken: Token | undefined;
    let targetMint: PublicKey | undefined;
    if (isBaseToSplSwap(swapEvent)) {
        inputToken = DEFAULT_TOKEN.WSOL;
        outputToken = newSplToken(new PublicKey(tokenOutputs[0].mint), tokenOutputs[0].rawTokenAmount.decimals);
        targetMint = outputToken.mint;
    } else if (isSplToBaseSwap(swapEvent)) {
        inputToken = newSplToken(new PublicKey(tokenInputs[0].mint), tokenInputs[0].rawTokenAmount.decimals);
        outputToken = DEFAULT_TOKEN.WSOL;
        targetMint = inputToken.mint;
    }
    // SPL-to-SPL and multi-hop swaps are not mirrored

    if (!inputToken || !outputToken || !targetMint) {
        throw new WorkerError(WorkerErrorType.SWAP_NOT_SUPPORTED, `Swap not currently supported`);
    }
    return { targetMint, outputToken, inputToken };
};
