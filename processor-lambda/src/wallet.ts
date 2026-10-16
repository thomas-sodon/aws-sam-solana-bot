import bs58 from 'bs58';
import config from 'config';

import { TokenAmount } from '@raydium-io/raydium-sdk';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

import { newTokenAmount } from './config';
import { ConnectionOptions } from './connection-pool';
import { WorkerError, WorkerErrorType } from './errors/worker-error';
import { WorkerContext } from './worker-context';

export const buildWallet = (privateKey: string) => {
    return Keypair.fromSecretKey(bs58.decode(privateKey));
};

export const getWalletTokenAmount = async (
    wc: WorkerContext,
    tokenMint: PublicKey,
    owner: PublicKey,
): Promise<TokenAmount> => {
    console.log(`Getting token amount for ${tokenMint} owned by ${owner.toString()}`);
    const tokenAddress = getAssociatedTokenAddressSync(new PublicKey(tokenMint), owner);
    console.log(`Token address: ${tokenAddress.toString()}`);
    let info;
    try {
        info = await wc
            .getConnectionPool()
            .executeWithConnection(
                'getTokenAccountBalance',
                (connection: Connection) => connection.getTokenAccountBalance(tokenAddress),
                config.get<ConnectionOptions>('connectionOptions.getTokenAccountBalance'),
            );
    } catch (e) {
        if ((e as any).message.includes('could not find account')) {
            throw new WorkerError(WorkerErrorType.TOKEN_ACCOUNT_NOT_FOUND, `${tokenMint}`);
        }
        throw e;
    }
    console.log(`Token account balance: ${info.value.amount}`);
    return newTokenAmount(tokenMint, info.value.amount, info.value.decimals);
};
