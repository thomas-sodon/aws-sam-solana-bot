import { ConditionalCheckFailedException, DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { claimSignature } from '../../src/idempotency';

// The DynamoDB client never leaves the process: send() is replaced for every test
const mockedSend = jest.spyOn(DynamoDBClient.prototype, 'send');

describe('claimSignature', () => {
    const originalTable = process.env.IDEMPOTENCY_TABLE;
    beforeEach(() => {
        process.env.IDEMPOTENCY_TABLE = 'processed-signatures';
    });
    afterEach(() => {
        if (originalTable === undefined) delete process.env.IDEMPOTENCY_TABLE;
        else process.env.IDEMPOTENCY_TABLE = originalTable;
    });

    it('claims a new signature with a conditional put and a TTL', async () => {
        mockedSend.mockResolvedValue({} as never);
        const now = Date.UTC(2024, 0, 1);
        await expect(claimSignature('sig-1', now)).resolves.toBe('claimed');

        expect(mockedSend).toHaveBeenCalledTimes(1);
        const command = mockedSend.mock.calls[0][0] as PutItemCommand;
        expect(command).toBeInstanceOf(PutItemCommand);
        expect(command.input).toEqual({
            TableName: 'processed-signatures',
            Item: {
                signature: { S: 'sig-1' },
                receivedAt: { S: '2024-01-01T00:00:00.000Z' },
                expiresAt: { N: String(now / 1000 + 7 * 24 * 60 * 60) },
            },
            ConditionExpression: 'attribute_not_exists(signature)',
        });
    });

    it('reports a signature that was already claimed as a duplicate', async () => {
        mockedSend.mockRejectedValue(
            new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} }) as never,
        );
        await expect(claimSignature('sig-1')).resolves.toBe('duplicate');
    });

    it('fails closed on any other DynamoDB error', async () => {
        mockedSend.mockRejectedValue(new Error('ProvisionedThroughputExceededException') as never);
        await expect(claimSignature('sig-1')).rejects.toThrow('ProvisionedThroughputExceededException');
    });

    it('skips the guard when no table is configured', async () => {
        delete process.env.IDEMPOTENCY_TABLE;
        await expect(claimSignature('sig-1')).resolves.toBe('unguarded');
        expect(mockedSend).not.toHaveBeenCalled();
    });
});
