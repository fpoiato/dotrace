import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
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

const AI_MARKER_PREFIX = 'aimark#';
/** AI spawn markers only need to survive the Lambda cold start + join. */
const AI_MARKER_TTL_SECONDS = 300;

const HANDOFF_PREFIX = 'aihand#';
/** Planned Lambda rotation: skip PLAYER_LEFT until the successor rejoins. */
const HANDOFF_TTL_SECONDS = 90;

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

export function isAiMarker(connectionId: string): boolean {
  return connectionId.startsWith(AI_MARKER_PREFIX);
}

export function isHandoffMarker(connectionId: string): boolean {
  return connectionId.startsWith(HANDOFF_PREFIX);
}

const OLLAYA_CONTROL_ID = 'sys#ollaya';

/** Websocket rows. Ghosts, AI markers, handoff markers, and the power record are not players. */
export function isLiveSocket(connectionId: string): boolean {
  return (
    !isGhost(connectionId) &&
    !isAiMarker(connectionId) &&
    !isHandoffMarker(connectionId) &&
    !connectionId.startsWith('sys#')
  );
}

export interface OllayaControl {
  generation: number;
  desired: 'running' | 'stopped' | '';
}

/** Bump the generation so an in-flight idle stop observes that it is stale. */
export async function bumpOllayaGeneration(desired: 'running' | 'stopped'): Promise<number> {
  const result = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { connectionId: OLLAYA_CONTROL_ID },
      UpdateExpression: 'ADD generation :one SET desired = :desired, roomCode = :room',
      ExpressionAttributeValues: {
        ':one': 1,
        ':desired': desired,
        ':room': 'sys',
      },
      ReturnValues: 'UPDATED_NEW',
    })
  );
  return Number(result.Attributes?.generation ?? 0);
}

export async function getOllayaControl(): Promise<OllayaControl> {
  const result = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { connectionId: OLLAYA_CONTROL_ID } })
  );
  const item = result.Item as { generation?: number; desired?: string } | undefined;
  const desired = item?.desired === 'running' || item?.desired === 'stopped' ? item.desired : '';
  return { generation: Number(item?.generation ?? 0), desired };
}

export async function countLiveSockets(): Promise<number> {
  let count = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
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

export function handoffMarkerId(roomCode: string, nickname: string): string {
  return `${HANDOFF_PREFIX}${roomCode}#${nickname.trim().toLowerCase()}`;
}

function aiMarkerId(roomCode: string, nickname: string): string {
  return `${AI_MARKER_PREFIX}${roomCode}#${nickname.trim().toLowerCase()}`;
}

/**
 * Record that the host requested an AI player with this nickname, so its
 * upcoming JOIN_ROOM can be auto-approved without host interaction.
 */
export async function putAiMarker(roomCode: string, nickname: string): Promise<void> {
  await putConnection({
    connectionId: aiMarkerId(roomCode, nickname),
    roomCode,
    nickname: nickname.trim(),
    color: '',
    isHost: false,
    joinOrder: -1,
    status: 'pending',
    ttl: Math.floor(Date.now() / 1000) + AI_MARKER_TTL_SECONDS,
  });
}

/** Check-and-delete the AI marker; true when the join should be auto-approved. */
export async function consumeAiMarker(roomCode: string, nickname: string): Promise<boolean> {
  const marker = await getConnection(aiMarkerId(roomCode, nickname));
  if (!marker) return false;
  await deleteConnection(aiMarkerId(roomCode, nickname));
  return true;
}

/**
 * Mark an in-progress AI Lambda rotation so disconnect does not drop the car.
 * `previousConnectionId` must match the closing socket.
 */
export async function putAiHandoffMarker(
  roomCode: string,
  nickname: string,
  previousConnectionId: string
): Promise<void> {
  await putConnection({
    connectionId: handoffMarkerId(roomCode, nickname),
    roomCode,
    nickname: nickname.trim(),
    color: '',
    isHost: false,
    joinOrder: -1,
    status: 'pending',
    previousConnectionId,
    ttl: Math.floor(Date.now() / 1000) + HANDOFF_TTL_SECONDS,
  });
}

export async function getAiHandoffMarker(
  roomCode: string,
  nickname: string
): Promise<ConnectionRecord | undefined> {
  return getConnection(handoffMarkerId(roomCode, nickname));
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
  return ((result.Items ?? []) as ConnectionRecord[]).filter(
    (c) =>
      !isGhost(c.connectionId) &&
      !isAiMarker(c.connectionId) &&
      !isHandoffMarker(c.connectionId)
  );
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
  const data = Buffer.from(JSON.stringify(message));
  try {
    await client.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: data,
      })
    );
    return true;
  } catch (err: unknown) {
    const status = (err as { statusCode?: number; name?: string }).statusCode;
    const name = (err as { name?: string }).name;
    if (status === 410 || name === 'GoneException') {
      await deleteConnection(connectionId);
    } else {
      console.warn(
        `[WS] send failed connection=${connectionId} status=${status ?? '?'} name=${name ?? '?'} bytes=${data.length}`
      );
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
