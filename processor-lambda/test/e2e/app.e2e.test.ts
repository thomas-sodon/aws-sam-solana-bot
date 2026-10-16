/**
 * END-TO-END SUITE - EXECUTES REAL MAINNET SWAPS WITH REAL FUNDS.
 *
 * These tests call the deployed handler code against live infrastructure: they load production
 * secrets from AWS Secrets Manager, sign with the bot wallet, and send real transactions to Solana
 * mainnet through Jupiter/Raydium, plus RPC, DexScreener, Helius and Telegram calls. Every run costs
 * SOL (swap amounts, fees and slippage) and can lose money.
 *
 * Skipped unless RUN_E2E=1 is set (`yarn test:e2e`). Never run it in CI or with a wallet you are not
 * prepared to spend from. The hermetic suite lives in test/unit and runs with `yarn unit`.
 */
import { APIGatewayProxyResult } from 'aws-lambda';

import { beforeAll, describe, expect, it } from '@jest/globals';
import { Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { PublicKey } from '@solana/web3.js';

import { lambdaHandler } from '../../src/app';
import { DEFAULT_TOKEN, newSplToken } from '../../src/config';
import { getMintInfo } from '../../src/pool-info';
import { SwapProgress, SwapProvider } from '../../src/types';
import { WorkerContext } from '../../src/worker-context';
import { pad } from '../util';
import { buildEvent, buildSwapEventBody } from '../util/test-data-factory';

const swapProcessingTime = 90000;
const describeE2e = process.env.RUN_E2E === '1' ? describe : describe.skip;

describeE2e('E2E: app handler against mainnet (real funds)', function () {
    let account: string;
    let wc: WorkerContext;
    let testToken: Token;

    beforeAll(async () => {
        wc = await WorkerContext.build();
        account = wc.wallet.publicKey.toString();
        const mintInfo = await getMintInfo(wc.connectionPool, targetMint);
        console.log('isInitialized: ', mintInfo.isInitialized);
        console.log('Freeze Authority: ', !!mintInfo.freezeAuthority);
        console.log('Mint Authority: ', !!mintInfo.mintAuthority);
        testToken = newSplToken(targetMint, mintInfo.decimals);
    }, 30000);
    it.skip('Verify not processed if not a valid event but has valid auth', async () => {
        const result: APIGatewayProxyResult = await lambdaHandler(
            buildEvent({
                headers: {
                    Authorization: wc.env.HELIUS_WEBHOOK_AUTH_HEADER,
                },
                body: '{\n  "event": "invalid"\n}',
            }),
        );

        expect(result.statusCode).toEqual(500);
        expect(JSON.parse(result.body)).toEqual({
            message: 'Unexpect error occurred',
        });
    });

    it.skip('Verify not processed if not a valid event and without valid auth', async () => {
        const result: APIGatewayProxyResult = await lambdaHandler(
            buildEvent({
                Authorization: 'not valid',
                body: 'invalid event',
            }),
        );

        expect(result.statusCode).toEqual(200);
        expect(JSON.parse(result.body)).toEqual({
            message: 'Not processed',
        });
    });

    it(
        'Jupiter Swap Test SOL => USDC',
        async () => {
            const amount = 100000;
            const result: APIGatewayProxyResult = await lambdaHandler(
                buildEvent({
                    headers: {
                        Authorization: wc.env.HELIUS_WEBHOOK_AUTH_HEADER,
                    },
                    body: JSON.stringify(
                        buildSwapEventBody(account, new TokenAmount(DEFAULT_TOKEN.WSOL, amount), DEFAULT_TOKEN.USDC),
                    ),
                }),
            );

            expect(result.statusCode).toEqual(200);
            const parsedBody = JSON.parse(result.body);
            expect(parsedBody).toMatchObject({
                message: 'Processed',
                result: {
                    messageToSendTransfer: expect.stringContaining(SwapProgress.SUCCESS),
                    numRetries: expect.any(Number),
                    swapProvider: SwapProvider.JUPITER,
                    transactionInputs: {
                        inputTokenAmount: {
                            currency: {
                                decimals: 9,
                                mint: 'So11111111111111111111111111111111111111112',
                                name: 'WSOL',
                                programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                                symbol: 'WSOL',
                            },
                            denominator: '3b9aca00',
                            numerator: pad(amount, 16, 6),
                            token: {
                                decimals: 9,
                                mint: 'So11111111111111111111111111111111111111112',
                                name: 'WSOL',
                                programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                                symbol: 'WSOL',
                            },
                        },
                        outputToken: {
                            decimals: 6,
                            mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                            name: 'UNKNOWN',
                            programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                            symbol: 'UNKNOWN',
                        },
                        targetMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                    },
                    transactionResult: {
                        txSuccess: true,
                        elapsedTime: expect.any(Number),
                        signature: expect.any(String),
                        status: {
                            confirmationStatus: 'confirmed',
                            confirmations: expect.any(Number),
                            err: null,
                            slot: expect.any(Number),
                            status: {
                                Ok: null,
                            },
                        },
                    },
                },
            });

            const signatureStatus = await wc
                .getConnectionPool()
                .getConnection()
                .getSignatureStatus(parsedBody.result.transactionResult.signature);
            expect(signatureStatus.value).toEqual({
                confirmationStatus: 'confirmed',
                confirmations: expect.any(Number),
                err: null,
                slot: expect.any(Number),
                status: { Ok: null },
            });
        },
        swapProcessingTime,
    );

    it.skip(
        'Jupiter Swap Test USDC => SOL',
        async () => {
            const amount = 10000;
            const result: APIGatewayProxyResult = await lambdaHandler(
                buildEvent({
                    headers: {
                        Authorization: wc.env.HELIUS_WEBHOOK_AUTH_HEADER,
                    },
                    body: JSON.stringify(
                        buildSwapEventBody(account, new TokenAmount(DEFAULT_TOKEN.USDC, amount), DEFAULT_TOKEN.WSOL),
                    ),
                }),
            );

            expect(result.statusCode).toEqual(200);
            const parsedBody = JSON.parse(result.body);
            expect(parsedBody).toEqual({
                message: 'Processed',
                result: {
                    messageToSendTransfer: expect.stringContaining(SwapProgress.SUCCESS),
                    numRetries: expect.any(Number),
                    swapProvider: SwapProvider.JUPITER,
                    transactionInputs: {
                        inputTokenAmount: {
                            currency: {
                                decimals: 6,
                                mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                                name: 'USDC',
                                programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                                symbol: 'USDC',
                            },
                            denominator: '0f4240',
                            numerator: amount.toString(16),
                            token: {
                                decimals: 6,
                                mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                                name: 'USDC',
                                programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                                symbol: 'USDC',
                            },
                        },
                        outputToken: {
                            decimals: 9,
                            mint: 'So11111111111111111111111111111111111111112',
                            name: 'WSOL',
                            programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                            symbol: 'WSOL',
                        },
                        targetMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                    },
                    transactionResult: {
                        txSuccess: true,
                        elapsedTime: expect.any(Number),
                        signature: expect.any(String),
                        status: {
                            confirmationStatus: 'confirmed',
                            confirmations: expect.any(Number),
                            err: null,
                            slot: expect.any(Number),
                            status: {
                                Ok: null,
                            },
                        },
                    },
                },
            });

            const signatureStatus = await wc
                .getConnectionPool()
                .getConnection()
                .getSignatureStatus(parsedBody.result.transactionResult.signature);
            expect(signatureStatus.value).toEqual({
                confirmationStatus: 'confirmed',
                confirmations: expect.any(Number),
                err: null,
                slot: expect.any(Number),
                status: { Ok: null },
            });
        },
        swapProcessingTime,
    );

    const isBuy = false;
    const targetMint = new PublicKey('2NZVyQGDYM4FTmrhLgFc8EFPVhbdgkztFR2ze4tGqDpE');
    it.skip(
        'Swap Test SOL => Token or Token => SOL',
        async () => {
            if (isBuy) {
                const amount = 100000;
                const result: APIGatewayProxyResult = await lambdaHandler(
                    buildEvent({
                        headers: {
                            Authorization: wc.env.HELIUS_WEBHOOK_AUTH_HEADER,
                        },
                        body: JSON.stringify(
                            buildSwapEventBody(account, new TokenAmount(DEFAULT_TOKEN.WSOL, amount), testToken),
                        ),
                    }),
                );

                expect(result.statusCode).toEqual(200);
                const parsedBody = JSON.parse(result.body);
                expect(parsedBody).toMatchObject({
                    message: 'Processed',
                    result: {
                        messageToSendTransfer: expect.stringContaining(SwapProgress.SUCCESS),
                        numRetries: expect.any(Number),
                        swapProvider: SwapProvider.JUPITER,
                        transactionInputs: {
                            inputTokenAmount: {
                                currency: {
                                    decimals: 9,
                                    mint: 'So11111111111111111111111111111111111111112',
                                    name: 'WSOL',
                                    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                                    symbol: 'WSOL',
                                },
                                denominator: '3b9aca00',
                                numerator: amount.toString(16),
                                token: {
                                    decimals: 9,
                                    mint: 'So11111111111111111111111111111111111111112',
                                    name: 'WSOL',
                                    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                                    symbol: 'WSOL',
                                },
                            },
                            outputToken: {
                                decimals: testToken.decimals,
                                mint: targetMint.toString(),
                                name: 'UNKNOWN',
                                programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                                symbol: 'UNKNOWN',
                            },
                            targetMint: targetMint.toString(),
                        },
                        transactionResult: {
                            txSuccess: true,
                            elapsedTime: expect.any(Number),
                            signature: expect.any(String),
                            status: {
                                confirmationStatus: 'confirmed',
                                confirmations: expect.any(Number),
                                err: null,
                                slot: expect.any(Number),
                                status: {
                                    Ok: null,
                                },
                            },
                        },
                    },
                });

                const signatureStatus = await wc
                    .getConnectionPool()
                    .getConnection()
                    .getSignatureStatus(parsedBody.result.transactionResult.signature);
                expect(signatureStatus.value).toEqual({
                    confirmationStatus: 'confirmed',
                    confirmations: expect.any(Number),
                    err: null,
                    slot: expect.any(Number),
                    status: { Ok: null },
                });
            } else {
                const amount = 1000000;
                const result: APIGatewayProxyResult = await lambdaHandler(
                    buildEvent({
                        headers: {
                            Authorization: wc.env.HELIUS_WEBHOOK_AUTH_HEADER,
                        },
                        body: JSON.stringify(
                            buildSwapEventBody(account, new TokenAmount(testToken, amount), DEFAULT_TOKEN.WSOL),
                        ),
                    }),
                );

                expect(result.statusCode).toEqual(200);
                const parsedBody = JSON.parse(result.body);
                expect(parsedBody).toEqual({
                    message: 'Processed',
                    result: {
                        messageToSendTransfer: expect.stringContaining(SwapProgress.SUCCESS),
                        numRetries: expect.any(Number),
                        swapProvider: SwapProvider.JUPITER,
                        transactionInputs: {
                            inputTokenAmount: {
                                currency: {
                                    decimals: testToken.decimals,
                                    mint: targetMint.toString(),
                                    name: 'UNKNOWN',
                                    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                                    symbol: 'UNKNOWN',
                                },
                                denominator: '0f4240',
                                numerator: amount.toString(16),
                                token: {
                                    decimals: testToken.decimals,
                                    mint: targetMint.toString(),
                                    name: 'UNKNOWN',
                                    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                                    symbol: 'UNKNOWN',
                                },
                            },
                            outputToken: {
                                decimals: 9,
                                mint: 'So11111111111111111111111111111111111111112',
                                name: 'WSOL',
                                programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                                symbol: 'WSOL',
                            },
                            targetMint: targetMint.toString(),
                        },
                        transactionResult: {
                            txSuccess: true,
                            elapsedTime: expect.any(Number),
                            signature: expect.any(String),
                            status: {
                                confirmationStatus: 'confirmed',
                                confirmations: expect.any(Number),
                                err: null,
                                slot: expect.any(Number),
                                status: {
                                    Ok: null,
                                },
                            },
                        },
                    },
                });

                const signatureStatus = await wc
                    .getConnectionPool()
                    .getConnection()
                    .getSignatureStatus(parsedBody.result.transactionResult.signature);
                expect(signatureStatus.value).toEqual({
                    confirmationStatus: 'confirmed',
                    confirmations: expect.any(Number),
                    err: null,
                    slot: expect.any(Number),
                    status: { Ok: null },
                });
            }
        },
        swapProcessingTime,
    );

    it.skip(
        'Raydium Swap Test Token => SOL',
        async () => {
            const amount = 1000000;
            const result: APIGatewayProxyResult = await lambdaHandler(
                buildEvent({
                    headers: {
                        Authorization: wc.env.HELIUS_WEBHOOK_AUTH_HEADER,
                    },
                    body: JSON.stringify(
                        buildSwapEventBody(account, new TokenAmount(testToken, amount), DEFAULT_TOKEN.WSOL),
                    ),
                }),
            );

            expect(result.statusCode).toEqual(200);
            const parsedBody = JSON.parse(result.body);
            expect(parsedBody).toEqual({
                message: 'Processed',
                result: {
                    messageToSendTransfer: expect.stringContaining(SwapProgress.SUCCESS),
                    numRetries: expect.any(Number),
                    swapProvider: SwapProvider.JUPITER,
                    transactionInputs: {
                        inputTokenAmount: {
                            currency: {
                                decimals: testToken.decimals,
                                mint: targetMint.toString(),
                                name: 'UNKNOWN',
                                programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                                symbol: 'UNKNOWN',
                            },
                            denominator: '0f4240',
                            numerator: amount.toString(16),
                            token: {
                                decimals: testToken.decimals,
                                mint: targetMint.toString(),
                                name: 'UNKNOWN',
                                programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                                symbol: 'UNKNOWN',
                            },
                        },
                        outputToken: {
                            decimals: 9,
                            mint: 'So11111111111111111111111111111111111111112',
                            name: 'WSOL',
                            programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                            symbol: 'WSOL',
                        },
                        targetMint: targetMint.toString(),
                    },
                    transactionResult: {
                        txSuccess: true,
                        elapsedTime: expect.any(Number),
                        signature: expect.any(String),
                        status: {
                            confirmationStatus: 'confirmed',
                            confirmations: expect.any(Number),
                            err: null,
                            slot: expect.any(Number),
                            status: {
                                Ok: null,
                            },
                        },
                    },
                },
            });

            const signatureStatus = await wc
                .getConnectionPool()
                .getConnection()
                .getSignatureStatus(parsedBody.result.transactionResult.signature);
            expect(signatureStatus.value).toEqual({
                confirmationStatus: 'confirmed',
                confirmations: expect.any(Number),
                err: null,
                slot: expect.any(Number),
                status: { Ok: null },
            });
        },
        swapProcessingTime,
    );
});
