import { Liquidity, LiquidityPoolKeys, SPL_ACCOUNT_LAYOUT, TOKEN_PROGRAM_ID } from '@raydium-io/raydium-sdk';
import { Connection, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

import { raydiumSlippagePercent } from '../config';
import { TransactionInputs } from '../types';
import { WorkerContext } from '../worker-context';

/**
 * Class representing a Raydium Swap operation.
 */
class RaydiumSwap {
    wc: WorkerContext;

    /**
     * Create a RaydiumSwap instance.
     * @param {WorkerContext} wc - Worker context providing the wallet and RPC connection pool.
     */
    constructor(wc: WorkerContext) {
        this.wc = wc;
    }

    /**
     * Retrieves token accounts owned by the wallet.
     * @async
     * @returns {Promise<TokenAccount[]>} An array of token accounts.
     */
    async getOwnerTokenAccounts() {
        const walletTokenAccount = await this.wc
            .getConnectionPool()
            .executeWithConnection('getTokenAccountsByOwner', (connection: Connection) =>
                connection.getTokenAccountsByOwner(this.wc.wallet.publicKey, {
                    programId: TOKEN_PROGRAM_ID,
                }),
            );
        console.log(`walletTokenAccount: ${JSON.stringify(walletTokenAccount, null, 2)}`);
        return walletTokenAccount.value.map((i) => ({
            pubkey: i.pubkey,
            programId: i.account.owner,
            accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
        }));
    }

    /**
     * Builds a fixed-input (fixedSide 'in') V0 swap transaction.
     * @async
     * @param {LiquidityPoolKeys} poolKeys - The liquidity pool keys.
     * @param {TransactionInputs} transactionInputs - Input token amount and output token.
     * @param {number} [computeUnitPriceMicroLamports=100000] - Priority fee as a compute-unit price, in micro-lamports per CU.
     * @returns {Promise<{versionedTransaction: VersionedTransaction, lastValidBlockHeight: number}>} The unsigned swap transaction.
     */
    async buildTransaction(
        poolKeys: LiquidityPoolKeys,
        transactionInputs: TransactionInputs,
        computeUnitPriceMicroLamports: number = 100000,
    ): Promise<{ versionedTransaction: VersionedTransaction; lastValidBlockHeight: number }> {
        const wc = this.wc;
        const fetchLiquidityInfo = await wc
            .getConnectionPool()
            .executeWithConnection('Liquidity.fetchInfo', (connection) =>
                Liquidity.fetchInfo({ connection, poolKeys }),
            );
        console.log(`fetchLiquidityInfo: ${JSON.stringify(fetchLiquidityInfo, null, 2)}`);
        // -------- step 1: compute amount out --------
        const { amountOut, minAmountOut } = Liquidity.computeAmountOut({
            poolKeys: poolKeys,
            poolInfo: fetchLiquidityInfo,
            amountIn: transactionInputs.inputTokenAmount,
            currencyOut: transactionInputs.outputToken,
            slippage: raydiumSlippagePercent,
        });

        console.log('amountOut:', amountOut.toFixed(), '  minAmountOut: ', minAmountOut.toFixed());
        const walletTokenAccounts = await this.getOwnerTokenAccounts();

        // -------- step 2: create instructions by SDK function --------
        const swapTransaction = await wc
            .getConnectionPool()
            .executeWithConnection('Liquidity.makeSwapInstructionSimple', (connection) =>
                Liquidity.makeSwapInstructionSimple({
                    connection,
                    poolKeys,
                    userKeys: {
                        tokenAccounts: walletTokenAccounts,
                        owner: wc.wallet.publicKey,
                    },
                    amountIn: transactionInputs.inputTokenAmount,
                    amountOut: minAmountOut,
                    fixedSide: 'in',
                    makeTxVersion: 0,
                    computeBudgetConfig: {
                        microLamports: computeUnitPriceMicroLamports,
                    },
                }),
            );
        console.log(`raydium swapTransaction: ${JSON.stringify(swapTransaction, null, 2)}`);

        const recentBlockhashForSwap = await this.wc
            .getConnectionPool()
            .executeWithConnection(
                'getLatestBlockhash',
                (connection: Connection) => connection.getLatestBlockhash('confirmed'),
                { retries: 1 },
            );
        console.log(`recentBlockhashForSwap: ${JSON.stringify(recentBlockhashForSwap, null, 2)}`);
        const lastValidBlockHeight = recentBlockhashForSwap.lastValidBlockHeight;
        const instructions = swapTransaction.innerTransactions[0].instructions.filter(Boolean);

        const versionedTransaction = new VersionedTransaction(
            new TransactionMessage({
                payerKey: this.wc.wallet.publicKey,
                recentBlockhash: recentBlockhashForSwap.blockhash,
                instructions,
            }).compileToV0Message(),
        );

        return { versionedTransaction, lastValidBlockHeight };
    }
}

export default RaydiumSwap;
