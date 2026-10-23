import { ConditionalCheckFailedException, DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';

// Records expire through DynamoDB TTL; a redelivery this late is not worth guarding against
const RECORD_TTL_SECONDS = 7 * 24 * 60 * 60;

let client: DynamoDBClient | undefined;
const getClient = () => {
    // AWS_REGION is always set inside Lambda; fall back to the SDK's default region resolution otherwise.
    client ??= new DynamoDBClient(process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {});
    return client;
};

export type ClaimResult = 'claimed' | 'duplicate' | 'unguarded';

/**
 * Claims a leader transaction signature before any trade is attempted, so a webhook retry or
 * redelivery of the same transaction is not mirrored twice.
 *
 * The claim is a DynamoDB conditional put on the signature (`attribute_not_exists`), which is atomic
 * across concurrent invocations. A signature that was already claimed returns `duplicate`. Any
 * other DynamoDB failure is thrown, so the handler reports an error instead of trading unguarded.
 * Without `IDEMPOTENCY_TABLE` (for example a local run outside SAM) the guard is off and the
 * result is `unguarded`.
 */
export const claimSignature = async (signature: string, nowMs = Date.now()): Promise<ClaimResult> => {
    const tableName = process.env.IDEMPOTENCY_TABLE;
    if (!tableName) {
        console.log('IDEMPOTENCY_TABLE is not set, skipping the duplicate-delivery guard');
        return 'unguarded';
    }
    try {
        await getClient().send(
            new PutItemCommand({
                TableName: tableName,
                Item: {
                    signature: { S: signature },
                    receivedAt: { S: new Date(nowMs).toISOString() },
                    expiresAt: { N: String(Math.floor(nowMs / 1000) + RECORD_TTL_SECONDS) },
                },
                ConditionExpression: 'attribute_not_exists(signature)',
            }),
        );
        return 'claimed';
    } catch (e) {
        if (e instanceof ConditionalCheckFailedException) {
            return 'duplicate';
        }
        throw e;
    }
};
