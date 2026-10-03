/**
 * Read-only view of the Dot Race connections table.
 * Dot Race keeps writing `sys#ollaya` itself; this host only observes it.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { LEGACY_CONTROL_ID } from '../../lib/contract';
import type { LegacyControl } from './policy';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** Same prefixes Dot Race uses for rows that are not open sockets. */
export function isLiveSocket(connectionId: string): boolean {
  return (
    !connectionId.startsWith('ghost#') &&
    !connectionId.startsWith('aimark#') &&
    !connectionId.startsWith('aihand#') &&
    !connectionId.startsWith('sys#')
  );
}

export async function readLegacyControl(tableName: string): Promise<LegacyControl> {
  const controlId = process.env.LEGACY_CONTROL_ID ?? LEGACY_CONTROL_ID;
  const result = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { connectionId: controlId } })
  );
  const item = result.Item as { generation?: number; desired?: string } | undefined;
  const desired = item?.desired === 'running' || item?.desired === 'stopped' ? item.desired : '';
  return { generation: Number(item?.generation ?? 0), desired };
}

export async function countLiveSockets(tableName: string): Promise<number> {
  let count = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: 'connectionId',
        ExclusiveStartKey: startKey,
      })
    );
    for (const item of result.Items ?? []) {
      const id = String((item as { connectionId?: string }).connectionId ?? '');
      if (isLiveSocket(id)) count += 1;
    }
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return count;
}
