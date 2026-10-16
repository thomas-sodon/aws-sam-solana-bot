import { APIGatewayProxyEvent } from 'aws-lambda';
import { EnrichedTransaction, NativeBalanceChange, Source, TokenBalanceChange, TransactionType } from 'helius-sdk';

import { Token, TokenAmount } from '@raydium-io/raydium-sdk';

export const buildEvent = (event: any): APIGatewayProxyEvent => {
    return {
        httpMethod: 'POST',
        body: '',
        headers: {},
        isBase64Encoded: false,
        multiValueHeaders: {},
        multiValueQueryStringParameters: {},
        path: '/processor',
        pathParameters: {},
        queryStringParameters: {},
        requestContext: {
            accountId: '123456789012',
            apiId: '1234',
            authorizer: {},
            httpMethod: 'POST',
            identity: {
                accessKey: '',
                accountId: '',
                apiKey: '',
                apiKeyId: '',
                caller: '',
                clientCert: {
                    clientCertPem: '',
                    issuerDN: '',
                    serialNumber: '',
                    subjectDN: '',
                    validity: { notAfter: '', notBefore: '' },
                },
                cognitoAuthenticationProvider: '',
                cognitoAuthenticationType: '',
                cognitoIdentityId: '',
                cognitoIdentityPoolId: '',
                principalOrgId: '',
                sourceIp: '',
                user: '',
                userAgent: '',
                userArn: '',
            },
            path: '/processor',
            protocol: 'HTTP/1.1',
            requestId: 'c6af9ac6-7b61-11e6-9a41-93e8deadbeef',
            requestTimeEpoch: 1428582896000,
            resourceId: '123456',
            resourcePath: '/processor',
            stage: 'dev',
        },
        resource: '',
        stageVariables: {},
        ...event,
    };
};

export const buildSwapEventBody = (
    account: string,
    inAmount: TokenAmount,
    outputToken: Token,
): EnrichedTransaction[] => {
    let nativeInput: NativeBalanceChange | null = null;
    let nativeOutput: NativeBalanceChange | null = null;
    const buildToken = (tokenAmount: TokenAmount) => ({
        mint: tokenAmount.token.mint.toString(),
        rawTokenAmount: {
            decimals: tokenAmount.token.decimals,
            tokenAmount: tokenAmount.raw.toString(10),
        },
        tokenAccount: account,
        userAccount: account,
    });
    const tokenOutputs: TokenBalanceChange[] = [];
    const tokenInputs: TokenBalanceChange[] = [];
    let description = 'I swapped ';
    if (inAmount.token.symbol === 'WSOL') {
        nativeInput = {
            account,
            amount: inAmount.raw.toNumber(),
        };
        description += `${nativeInput.amount} SOL for `;
    } else {
        tokenInputs.push(buildToken(inAmount));
        description += `${inAmount.raw.toString(10)} ${inAmount.token.symbol} for `;
    }

    const amount = 0;
    if (outputToken.symbol === 'WSOL') {
        description += `some SOL`;
        nativeOutput = {
            account,
            amount,
        };
    } else {
        description += `some ${outputToken.symbol}`;
        tokenOutputs.push(buildToken(new TokenAmount(outputToken, amount)));
    }

    return [
        {
            description,
            fee: 0,
            feePayer: account,
            events: {
                nft: null,
                compressed: null,
                swap: {
                    tokenFees: [],
                    nativeFees: [],
                    innerSwaps: [],
                    nativeInput: nativeInput as NativeBalanceChange,
                    nativeOutput: nativeOutput as NativeBalanceChange,
                    tokenInputs,
                    tokenOutputs,
                },
            },
            source: Source.JUPITER,
            timestamp: 1712699547,
            type: TransactionType.SWAP,
            signature: 'abc123',
            slot: 0,
            nativeTransfers: null,
            tokenTransfers: null,
            accountData: [],
            transactionError: null,
            instructions: [],
        },
    ];
};
