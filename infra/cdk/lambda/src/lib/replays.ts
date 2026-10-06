import { randomBytes } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Compact replay stored for one day. The share link carries only `replayId`;
 * the race itself stays here so a 3-lap log never has to fit in a URL.
 */
export interface SharedReplayPlayer {
  id: string;
  n: string;
  c: string;
  jo: number;
  h?: 1;
  fo?: number;
  fr?: number;
  fa?: number;
  d?: number;
}

/** [playerIdx, round, x, y, vx, vy, offTrack(0|1), lap] */
export type SharedMoveRow = [number, number, number, number, number, number, 0 | 1, number];

export interface SharedReplayPayload {
  v: 1;
  t: string;
  l: number;
  m: 'TURNS' | 'TIMED';
  p: SharedReplayPlayer[];
  r: SharedMoveRow[];
}

export type ReplaySaveResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'invalid' | 'too_large' };

/** DynamoDB TTL is unix seconds. Items disappear about a day after they are saved. */
export const REPLAY_TTL_SECONDS = 24 * 60 * 60;

/** Stay under the 400 KB item limit once keys and the JSON string are counted. */
export const MAX_REPLAY_BYTES = 350_000;

const MAX_PLAYERS = 32;
const MAX_MOVES = 2000;
const MAX_NAME = 40;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function tableName(): string {
  const name = process.env.REPLAYS_TABLE;
  if (!name) throw new Error('REPLAYS_TABLE not configured');
  return name;
}

export function replayTtl(nowSeconds = Math.floor(Date.now() / 1000)): number {
  return nowSeconds + REPLAY_TTL_SECONDS;
}

/** 12-char url-safe id. Short enough to share; random enough to guess. */
export function newReplayId(): string {
  return randomBytes(9).toString('base64url');
}

export function isReplayId(id: string): boolean {
  return /^[A-Za-z0-9_-]{12}$/.test(id);
}

function isCoord(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1_000_000;
}

function optionalInt(value: unknown, maxAbs: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > maxAbs) {
    return Number.NaN;
  }
  return value;
}

function normalizePlayer(value: unknown): SharedReplayPlayer | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !/^p\d{1,3}$/.test(row.id)) return null;
  if (typeof row.n !== 'string') return null;
  const name = row.n.trim();
  if (!name || name.length > MAX_NAME) return null;
  if (typeof row.c !== 'string' || row.c.length < 1 || row.c.length > 20) return null;
  if (typeof row.jo !== 'number' || !Number.isFinite(row.jo)) return null;

  const player: SharedReplayPlayer = { id: row.id, n: name, c: row.c, jo: row.jo };
  if (row.h !== undefined && row.h !== 1) return null;
  if (row.h === 1) player.h = 1;

  const fo = optionalInt(row.fo, 64);
  const fr = optionalInt(row.fr, 100_000);
  const fa = optionalInt(row.fa, 10_000_000_000_000);
  const dice = optionalInt(row.d, 100);
  if (Number.isNaN(fo) || Number.isNaN(fr) || Number.isNaN(fa) || Number.isNaN(dice)) return null;
  if (fo !== undefined) player.fo = fo;
  if (fr !== undefined) player.fr = fr;
  if (fa !== undefined) player.fa = fa;
  if (dice !== undefined) player.d = dice;
  return player;
}

function normalizeMove(value: unknown, playerCount: number): SharedMoveRow | null {
  if (!Array.isArray(value) || value.length !== 8) return null;
  const [pi, round, x, y, vx, vy, off, lap] = value;
  if (typeof pi !== 'number' || !Number.isInteger(pi) || pi < 0 || pi >= playerCount) return null;
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 0 || round > 100_000) return null;
  if (!isCoord(x) || !isCoord(y) || !isCoord(vx) || !isCoord(vy)) return null;
  if (off !== 0 && off !== 1) return null;
  if (typeof lap !== 'number' || !Number.isInteger(lap) || lap < 0 || lap > 10) return null;
  return [pi, round, x, y, vx, vy, off, lap];
}

/** Drop unknown fields and reject anything that is not a finished-race replay. */
export function normalizeReplayPayload(value: unknown): SharedReplayPayload | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1) return null;
  if (typeof raw.t !== 'string' || !/^[a-z0-9-]{1,40}$/i.test(raw.t)) return null;
  if (raw.l !== 1 && raw.l !== 2 && raw.l !== 3) return null;
  if (raw.m !== 'TURNS' && raw.m !== 'TIMED') return null;
  if (!Array.isArray(raw.p) || raw.p.length < 1 || raw.p.length > MAX_PLAYERS) return null;
  if (!Array.isArray(raw.r) || raw.r.length < 1 || raw.r.length > MAX_MOVES) return null;

  const players: SharedReplayPlayer[] = [];
  for (const entry of raw.p) {
    const player = normalizePlayer(entry);
    if (!player) return null;
    players.push(player);
  }

  const moves: SharedMoveRow[] = [];
  for (const entry of raw.r) {
    const move = normalizeMove(entry, players.length);
    if (!move) return null;
    moves.push(move);
  }

  return { v: 1, t: raw.t, l: raw.l, m: raw.m, p: players, r: moves };
}

function isConditionalCheckFailed(err: unknown): boolean {
  return (err as { name?: string }).name === 'ConditionalCheckFailedException';
}

export async function saveReplay(input: unknown): Promise<ReplaySaveResult> {
  const payload = normalizeReplayPayload(input);
  if (!payload) return { ok: false, reason: 'invalid' };
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > MAX_REPLAY_BYTES) return { ok: false, reason: 'too_large' };

  for (let attempt = 0; attempt < 3; attempt++) {
    const replayId = newReplayId();
    try {
      await ddb.send(
        new PutCommand({
          TableName: tableName(),
          Item: {
            replayId,
            payload: body,
            ttl: replayTtl(),
            createdAt: Date.now(),
          },
          ConditionExpression: 'attribute_not_exists(replayId)',
        })
      );
      return { ok: true, id: replayId };
    } catch (err) {
      if (!isConditionalCheckFailed(err) || attempt === 2) throw err;
    }
  }
  throw new Error('Could not allocate replay id');
}

/**
 * Load a replay that is still inside its TTL. Dynamo deletes expired items
 * eventually, so a row whose `ttl` has already passed is treated as missing.
 */
export async function loadReplay(replayId: string): Promise<SharedReplayPayload | undefined> {
  if (!isReplayId(replayId)) return undefined;
  const result = await ddb.send(
    new GetCommand({ TableName: tableName(), Key: { replayId } })
  );
  const item = result.Item as { payload?: unknown; ttl?: unknown } | undefined;
  if (!item || typeof item.payload !== 'string') return undefined;
  if (typeof item.ttl === 'number' && item.ttl <= Math.floor(Date.now() / 1000)) return undefined;
  try {
    return normalizeReplayPayload(JSON.parse(item.payload)) ?? undefined;
  } catch {
    return undefined;
  }
}
