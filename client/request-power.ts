/**
 * Ask the shared host to start or stop. Call this from any project except
 * Dot Race, which still sends the legacy `{ action, generation }` payload
 * from its own connections table.
 *
 * Env: LAYA_CONTROL_TABLE (default LayaControl), LAYA_POWER_FUNCTION_NAME (default LayaPower).
 * The caller needs dynamodb:UpdateItem on its own row and lambda:InvokeFunction.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LAYA_CONTROL_TABLE_NAME, LAYA_POWER_FUNCTION_NAME, LEGACY_CONSUMER } from '../lib/contract';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = new LambdaClient({});

export async function requestLayaPower(
  action: 'start' | 'stop',
  consumer: string
): Promise<void> {
  const name = consumer.trim();
  if (!name || name === LEGACY_CONSUMER) {
    throw new Error(
      `consumer must be a project id other than "${LEGACY_CONSUMER}". Dot Race keeps its own caller.`
    );
  }

  const tableName = process.env.LAYA_CONTROL_TABLE ?? LAYA_CONTROL_TABLE_NAME;
  const functionName = process.env.LAYA_POWER_FUNCTION_NAME ?? LAYA_POWER_FUNCTION_NAME;
  const updated = await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { consumer: name },
      UpdateExpression: 'ADD generation :one SET desired = :desired, updatedAt = :now',
      ExpressionAttributeValues: {
        ':one': 1,
        ':desired': action === 'start' ? 'running' : 'stopped',
        ':now': Date.now(),
      },
      ReturnValues: 'UPDATED_NEW',
    })
  );
  const generation = Number(updated.Attributes?.generation ?? 0);
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ action, consumer: name, generation })),
    })
  );
}
