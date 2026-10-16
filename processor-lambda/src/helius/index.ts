import { GetPriorityFeeEstimateRequest, GetPriorityFeeEstimateResponse, PriorityLevel } from 'helius-sdk';
import fetch from 'node-fetch';

import { PublicKey } from '@solana/web3.js';

import { RpcProvider } from '../config';
import { HeliusError, HeliusErrorType } from '../errors/helius-error';
import { HeliusPriorityLevel, RpcResult } from '../types';
import { WorkerContext } from '../worker-context';

export async function getPriorityFeeEstimateByMint(
    wc: WorkerContext,
    tokenMint: PublicKey,
    priorityLevel: HeliusPriorityLevel,
): Promise<number> {
    const request: GetPriorityFeeEstimateRequest = {
        accountKeys: [tokenMint.toString()],
        options: {
            priorityLevel: priorityLevel as unknown as PriorityLevel,
        },
    };

    const data = await wc.getConnectionPool().executeWithConnection(
        'getPriorityFeeEstimate',
        async (connection) => {
            const fetchedData = await fetch(connection.rpcEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: '1',
                    method: 'getPriorityFeeEstimate',
                    params: [
                        {
                            ...request,
                        },
                    ],
                }),
            });
            const jsonData = await fetchedData.json();
            return jsonData as RpcResult<GetPriorityFeeEstimateResponse>;
        },
        { rpcProvider: RpcProvider.HELIUS },
    );

    console.log(`getPriorityFeeEstimateByMint data: ${JSON.stringify(data, null, 2)}`);
    if (!data || !data.result || data.result.priorityFeeEstimate === undefined) {
        throw new HeliusError(
            HeliusErrorType.PRIORITY_FEE_FAIL,
            `Failed to get priority fee estimate for mint: ${tokenMint} with response: ${JSON.stringify(data)}`,
        );
    }
    const priorityFeeEstimate = Math.trunc(data.result.priorityFeeEstimate);
    console.log(`getPriorityFeeEstimateByMint: ${priorityFeeEstimate}`);
    return priorityFeeEstimate;
}
