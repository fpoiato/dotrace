import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Live board and replay chunks for one room. The WebSocket only carries the
 * slim board; Laya and the post-race replay read this table. TTL drops the
 * row after the race is over.
 */
const LIVE_TTL_SECONDS = 6 * 60 * 60;
const MAX_CHUNK = 80;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function tableName(): string | undefined {
  return process.env.REPLAYS_TABLE;
}

function ttl(): number {
  return Math.floor(Date.now() / 1000) + LIVE_TTL_SECONDS;
}

export function boardKey(roomCode: string): string {
  return `live-${roomCode}`;
}

export function chunkKey(roomCode: string, index: number): string {
  return `live-${roomCode}-c${index}`;
}

export async function saveLiveBoard(roomCode: string, state: unknown): Promise<void> {
  const name = tableName();
  if (!name || !roomCode || !state) return;
  await ddb.send(
    new PutCommand({
      TableName: name,
      Item: { replayId: boardKey(roomCode), payload: state, ttl: ttl() },
    })
  );
}

export async function loadLiveBoard(roomCode: string): Promise<unknown | undefined> {
  const name = tableName();
  if (!name || !roomCode) return undefined;
  const result = await ddb.send(
    new GetCommand({ TableName: name, Key: { replayId: boardKey(roomCode) } })
  );
  return (result.Item as { payload?: unknown } | undefined)?.payload;
}

export async function saveReplayChunk(
  roomCode: string,
  index: number,
  moves: unknown[]
): Promise<void> {
  const name = tableName();
  if (!name || !roomCode || !Array.isArray(moves) || moves.length === 0) return;
  await ddb.send(
    new PutCommand({
      TableName: name,
      Item: {
        replayId: chunkKey(roomCode, index),
        payload: moves.slice(0, MAX_CHUNK),
        ttl: ttl(),
      },
    })
  );
}

export async function loadReplayChunks(roomCode: string): Promise<unknown[]> {
  const name = tableName();
  if (!name || !roomCode) return [];
  const moves: unknown[] = [];
  for (let index = 0; index < 40; index += 1) {
    const result = await ddb.send(
      new GetCommand({ TableName: name, Key: { replayId: chunkKey(roomCode, index) } })
    );
    const chunk = (result.Item as { payload?: unknown } | undefined)?.payload;
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    moves.push(...chunk);
  }
  return moves;
}

