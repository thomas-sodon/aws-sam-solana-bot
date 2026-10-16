import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { Env } from './types';

const DEFAULT_SECRET_ID = 'prod/SolanaBot';

/**
 * Splits a comma-separated secret value into a trimmed list, ignoring blanks.
 * Missing or non-string values yield an empty list instead of throwing.
 */
export const splitList = (value?: unknown): string[] =>
    typeof value === 'string'
        ? value
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean)
        : [];

export const buildSecrets = async (): Promise<Env> => {
    const secretId = process.env.SECRET_ID || DEFAULT_SECRET_ID;
    // AWS_REGION is always set inside Lambda; fall back to the SDK's default region resolution otherwise.
    const client = new SecretsManagerClient(process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {});

    const response = await client.send(
        new GetSecretValueCommand({
            SecretId: secretId,
            VersionStage: 'AWSCURRENT', // VersionStage defaults to AWSCURRENT if unspecified
        }),
    );

    if (!response.SecretString) {
        throw new Error('SecretString is undefined');
    }
    const secrets = JSON.parse(response.SecretString);
    secrets.HELIUS_RPC_POOL_API_KEYS = splitList(secrets.HELIUS_RPC_POOL_API_KEYS);
    secrets.SHYFT_RPC_POOL_API_KEYS = splitList(secrets.SHYFT_RPC_POOL_API_KEYS);
    secrets.HELLOMOON_RPC_POOL_API_KEYS = splitList(secrets.HELLOMOON_RPC_POOL_API_KEYS);
    secrets.CHAINSTACK_RPC_POOL_API_KEYS = splitList(secrets.CHAINSTACK_RPC_POOL_API_KEYS);
    secrets.ALCHEMY_RPC_POOL_API_KEYS = splitList(secrets.ALCHEMY_RPC_POOL_API_KEYS);
    secrets.SKIP_LIQUIDITY_CHECK = splitList(secrets.SKIP_LIQUIDITY_CHECK);

    return secrets as unknown as Env;
};
