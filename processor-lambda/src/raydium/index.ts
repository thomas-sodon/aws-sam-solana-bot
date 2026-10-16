import { ApiPoolInfoItem, jsonInfo2PoolKeys, LiquidityPoolKeys } from '@raydium-io/raydium-sdk';

import { SwapTransaction, TransactionInputs } from '../types';
import { WorkerContext } from '../worker-context';
import RaydiumSwap from './RaydiumSwap';

/**
 * Performs a token swap on the Raydium protocol.
 * Depending on the configuration, it can execute the swap or simulate it.
 */
export const buildRaydiumSwapTransaction = async (
    wc: WorkerContext,
    transactionInputs: TransactionInputs,
    poolInfo: ApiPoolInfoItem,
    computeUnitPriceMicroLamports?: number,
): Promise<SwapTransaction> => {
    /**
     * The RaydiumSwap instance for handling swaps.
     */
    const raydiumSwap = new RaydiumSwap(wc);
    console.log(`Perform Raydium swap...`);
    const amount = transactionInputs.inputTokenAmount.raw.toString(10);
    const inputMint = transactionInputs.inputTokenAmount.token.mint.toString();
    const outputMint = transactionInputs.outputToken.mint.toString();
    console.log(`Swapping ${amount} of ${inputMint} for ${outputMint}...`);

    const poolKeys = jsonInfo2PoolKeys(poolInfo) as LiquidityPoolKeys;
    /**
     * Prepare the swap transaction with the given parameters.
     */
    const { versionedTransaction, lastValidBlockHeight } = await raydiumSwap.buildTransaction(
        poolKeys,
        transactionInputs,
        computeUnitPriceMicroLamports,
    );

    return {
        versionedTransaction,
        prioritizationFeeLamports: computeUnitPriceMicroLamports,
        lastValidBlockHeight,
    };
};
