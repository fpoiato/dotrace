import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';

export interface ConnectionRecord {
  connectionId: string;
  roomCode: string;
  nickname: string;
  color: string;
  isHost: boolean;
  joinOrder: number;
  status: 'pending' | 'approved';
  ttl: number;
  previousConnectionId?: string;
  wasHost?: boolean;
}

const GHOST_PREFIX = 'ghost#';
/** Keep disconnected players rejoinable longer (mobile background / lock screen). */
const GHOST_TTL_SECONDS = 3600;

const PLAYER_COLORS = [
  '#EF4444',
  '#3B82F6',
  '#22C55E',
  '#EAB308',
  '#A855F7',
  '#EC4899',
  '#14B8A6',
  '#F97316',
  '#6366F1',
  '#84CC16',
  '#06B6D4',
  '#F43F5E',
];

export function isGhost(connectionId: string): boolean {
  return connectionId.startsWith(GHOST_PREFIX);
}

export function ghostId(roomCode: string, nickname: string): string {
  return `${GHOST_PREFIX}${roomCode}#${nickname.trim().toLowerCase()}`;
}

export function ttlGhost(): number {
  return Math.floor(Date.now() / 1000) + GHOST_TTL_SECONDS;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.CONNECTIONS_TABLE!;

export function ttl24h(): number {
  return Math.floor(Date.now() / 1000) + 86400;
}

export async function getConnection(connectionId: string): Promise<ConnectionRecord | undefined> {
  const result = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { connectionId } })
  );
  return result.Item as ConnectionRecord | undefined;
}

export async function putConnection(record: ConnectionRecord): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: record }));
}

export async function deleteConnection(connectionId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { connectionId } }));
}

export async function getRoomConnections(roomCode: string): Promise<ConnectionRecord[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'RoomCodeIndex',
      KeyConditionExpression: 'roomCode = :roomCode',
      ExpressionAttributeValues: { ':roomCode': roomCode },
    })
  );
  return ((result.Items ?? []) as ConnectionRecord[]).filter((c) => !isGhost(c.connectionId));
}

export async function getApprovedConnections(roomCode: string): Promise<ConnectionRecord[]> {
  return (await getRoomConnections(roomCode)).filter((c) => c.status === 'approved');
}

export async function getHostConnection(roomCode: string): Promise<ConnectionRecord | undefined> {
  const connections = await getApprovedConnections(roomCode);
  return connections.find((c) => c.isHost);
}

export function getApiClient(): ApiGatewayManagementApiClient {
  const endpoint = process.env.WEBSOCKET_ENDPOINT;
  if (!endpoint) {
    throw new Error('WEBSOCKET_ENDPOINT not configured');
  }
  return new ApiGatewayManagementApiClient({ endpoint });
}

export async function sendToConnection(
  connectionId: string,
  message: unknown
): Promise<boolean> {
  const client = getApiClient();
  try {
    await client.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(message)),
      })
    );
    return true;
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 410) {
      await deleteConnection(connectionId);
    }
    return false;
  }
}

export async function broadcastToRoom(
  roomCode: string,
  message: unknown,
  excludeConnectionId?: string
): Promise<void> {
  const connections = await getRoomConnections(roomCode);
  await Promise.all(
    connections
      .filter((c) => c.connectionId !== excludeConnectionId)
      .map((c) => sendToConnection(c.connectionId, message))
  );
}

export async function broadcastToApproved(
  roomCode: string,
  message: unknown,
  excludeConnectionId?: string
): Promise<void> {
  const connections = await getApprovedConnections(roomCode);
  await Promise.all(
    connections
      .filter((c) => c.connectionId !== excludeConnectionId)
      .map((c) => sendToConnection(c.connectionId, message))
  );
}

export async function promoteNextHost(
  roomCode: string,
  excludeConnectionId: string
): Promise<ConnectionRecord | undefined> {
  const approved = (await getApprovedConnections(roomCode))
    .filter((c) => c.connectionId !== excludeConnectionId)
    .sort((a, b) => a.joinOrder - b.joinOrder);

  if (approved.length === 0) {
    return undefined;
  }

  const newHost = approved[0];

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { connectionId: newHost.connectionId },
      UpdateExpression: 'SET isHost = :true',
      ExpressionAttributeValues: { ':true': true },
    })
  );

  for (const conn of approved.slice(1)) {
    if (conn.isHost) {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { connectionId: conn.connectionId },
          UpdateExpression: 'SET isHost = :false',
          ExpressionAttributeValues: { ':false': false },
        })
      );
    }
  }

  return { ...newHost, isHost: true };
}

export function generateRoomCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += letters[Math.floor(Math.random() * letters.length)];
  }
  return code;
}

export async function roomCodeExists(roomCode: string): Promise<boolean> {
  const connections = await getRoomConnections(roomCode);
  return connections.some((c) => c.status === 'approved');
}

export async function nicknameTaken(roomCode: string, nickname: string): Promise<boolean> {
  const connections = await getRoomConnections(roomCode);
  return connections.some(
    (c) => c.nickname.toLowerCase() === nickname.toLowerCase()
  );
}

export async function nextPlayerColor(roomCode: string): Promise<string> {
  const connections = await getRoomConnections(roomCode);
  const used = new Set(connections.map((c) => c.color));
  for (const color of PLAYER_COLORS) {
    if (!used.has(color)) return color;
  }
  return PLAYER_COLORS[connections.length % PLAYER_COLORS.length];
}

export async function saveGhost(record: ConnectionRecord): Promise<void> {
  await putConnection({
    connectionId: ghostId(record.roomCode, record.nickname),
    roomCode: record.roomCode,
    nickname: record.nickname,
    color: record.color,
    isHost: false,
    wasHost: record.isHost,
    joinOrder: record.joinOrder,
    status: record.status,
    previousConnectionId: record.connectionId,
    ttl: ttlGhost(),
  });
}

export async function getGhost(
  roomCode: string,
  nickname: string
): Promise<ConnectionRecord | undefined> {
  return getConnection(ghostId(roomCode, nickname));
}

export async function deleteGhost(roomCode: string, nickname: string): Promise<void> {
  await deleteConnection(ghostId(roomCode, nickname));
}

export function toPlayer(record: ConnectionRecord): {
  connectionId: string;
  nickname: string;
  color: string;
  isHost: boolean;
  joinOrder: number;
  status: 'pending' | 'approved';
} {
  return {
    connectionId: record.connectionId,
    nickname: record.nickname,
    color: record.color,
    isHost: record.isHost,
    joinOrder: record.joinOrder,
    status: record.status,
  };
}

export const MAX_PLAYERS = 12;
