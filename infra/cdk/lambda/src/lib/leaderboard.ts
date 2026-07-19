import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

/** Cumulative global stats keyed by normalized nickname. */
export interface LeaderboardRecord {
  nicknameKey: string;
  displayName: string;
  races: number;
  wins: number;
  podiums: number;
  bestLapMs?: number;
  bestLapRounds?: number;
  updatedAt: number;
  /** Constant GSI partition for Top-N queries. */
  board: 'global';
  /**
   * GSI sort key — lower sorts first.
   * Encodes inverted wins/podiums so Query Limit=10 returns the leaders.
   */
  rankKey: string;
}

/** Per-race delta submitted by the host after GAME_OVER. */
export interface RaceStatDelta {
  nickname: string;
  races: number;
  wins: number;
  podiums: number;
  bestLapMs?: number;
  bestLapRounds?: number;
}

export interface Top10Entry {
  nickname: string;
  races: number;
  wins: number;
  podiums: number;
  bestLapMs?: number;
  bestLapRounds?: number;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.LEADERBOARD_TABLE!;
const BOARD = 'global';
const TOP_N = 10;
const SCORE_PAD = 1_000_000;

export function nicknameKey(nickname: string): string {
  return nickname.trim().toLowerCase();
}

export function buildRankKey(wins: number, podiums: number, key: string): string {
  const w = String(SCORE_PAD - Math.max(0, Math.min(SCORE_PAD - 1, wins))).padStart(6, '0');
  const p = String(SCORE_PAD - Math.max(0, Math.min(SCORE_PAD - 1, podiums))).padStart(6, '0');
  return `${w}#${p}#${key}`;
}

function clampDelta(raw: RaceStatDelta): RaceStatDelta | null {
  const nickname = raw.nickname?.trim() ?? '';
  if (!nickname || nickname.length > 20) return null;
  return {
    nickname,
    races: Math.max(0, Math.min(1, Math.floor(Number(raw.races) || 0))),
    wins: Math.max(0, Math.min(1, Math.floor(Number(raw.wins) || 0))),
    podiums: Math.max(0, Math.min(1, Math.floor(Number(raw.podiums) || 0))),
    bestLapMs:
      typeof raw.bestLapMs === 'number' && raw.bestLapMs > 0 && Number.isFinite(raw.bestLapMs)
        ? Math.floor(raw.bestLapMs)
        : undefined,
    bestLapRounds:
      typeof raw.bestLapRounds === 'number' &&
      raw.bestLapRounds > 0 &&
      Number.isFinite(raw.bestLapRounds)
        ? Math.floor(raw.bestLapRounds)
        : undefined,
  };
}

/**
 * Apply one race's results for a player.
 * Counters are ADD'd; bests use conditional updates when the new value is better.
 */
export async function applyRaceStatDelta(raw: RaceStatDelta): Promise<void> {
  const delta = clampDelta(raw);
  if (!delta) return;
  if (
    delta.races === 0 &&
    delta.wins === 0 &&
    delta.podiums === 0 &&
    delta.bestLapMs === undefined &&
    delta.bestLapRounds === undefined
  ) {
    return;
  }

  const key = nicknameKey(delta.nickname);
  const now = Date.now();

  const after = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { nicknameKey: key },
      UpdateExpression:
        'ADD races :r, wins :w, podiums :p SET displayName = :name, updatedAt = :now, board = :board',
      ExpressionAttributeValues: {
        ':r': delta.races,
        ':w': delta.wins,
        ':p': delta.podiums,
        ':name': delta.nickname,
        ':now': now,
        ':board': BOARD,
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  const item = after.Attributes as LeaderboardRecord | undefined;
  const wins = item?.wins ?? delta.wins;
  const podiums = item?.podiums ?? delta.podiums;

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { nicknameKey: key },
      UpdateExpression: 'SET rankKey = :rk, updatedAt = :now',
      ExpressionAttributeValues: {
        ':rk': buildRankKey(wins, podiums, key),
        ':now': now,
      },
    })
  );

  if (delta.bestLapMs !== undefined) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { nicknameKey: key },
          UpdateExpression: 'SET bestLapMs = :lap, updatedAt = :now',
          ConditionExpression: 'attribute_not_exists(bestLapMs) OR bestLapMs > :lap',
          ExpressionAttributeValues: { ':lap': delta.bestLapMs, ':now': now },
        })
      );
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    }
  }

  if (delta.bestLapRounds !== undefined) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { nicknameKey: key },
          UpdateExpression: 'SET bestLapRounds = :rounds, updatedAt = :now',
          ConditionExpression: 'attribute_not_exists(bestLapRounds) OR bestLapRounds > :rounds',
          ExpressionAttributeValues: { ':rounds': delta.bestLapRounds, ':now': now },
        })
      );
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    }
  }
}

export async function applyRaceStatDeltas(deltas: RaceStatDelta[]): Promise<number> {
  const limited = deltas.slice(0, 12);
  let applied = 0;
  for (const delta of limited) {
    const before = clampDelta(delta);
    if (!before) continue;
    await applyRaceStatDelta(before);
    applied += 1;
  }
  return applied;
}

export async function getTop10(): Promise<Top10Entry[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'BoardRankIndex',
      KeyConditionExpression: 'board = :board',
      ExpressionAttributeValues: { ':board': BOARD },
      ScanIndexForward: true,
      Limit: TOP_N,
    })
  );

  return ((result.Items ?? []) as LeaderboardRecord[]).map((row) => ({
    nickname: row.displayName || row.nicknameKey,
    races: row.races ?? 0,
    wins: row.wins ?? 0,
    podiums: row.podiums ?? 0,
    bestLapMs: row.bestLapMs,
    bestLapRounds: row.bestLapRounds,
  }));
}
