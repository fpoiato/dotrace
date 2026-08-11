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
   * Encodes: more wins → lower bestLapMs → lower bestLapRounds → name.
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
/** Wins inverted into a 6-digit field (supports up to 999_999 wins). */
const WINS_PAD = 1_000_000;
/**
 * Missing / unknown best-lap time sorts last. 10 digits covers ~115 days —
 * well above any real race lap.
 */
const MAX_LAP_MS = 9_999_999_999;
/** Missing best-lap rounds sorts last (6 digits). */
const MAX_LAP_ROUNDS = 999_999;

export function nicknameKey(nickname: string): string {
  return nickname.trim().toLowerCase();
}

/**
 * Ascending DynamoDB sort key for the global board.
 * Order: more wins → lower bestLapMs → lower bestLapRounds → nicknameKey.
 */
export function buildRankKey(
  wins: number,
  bestLapMs: number | undefined,
  bestLapRounds: number | undefined,
  key: string
): string {
  const w = String(WINS_PAD - Math.max(0, Math.min(WINS_PAD - 1, wins))).padStart(6, '0');
  const lap =
    typeof bestLapMs === 'number' && bestLapMs > 0 && Number.isFinite(bestLapMs)
      ? Math.min(MAX_LAP_MS, Math.floor(bestLapMs))
      : MAX_LAP_MS;
  const rounds =
    typeof bestLapRounds === 'number' && bestLapRounds > 0 && Number.isFinite(bestLapRounds)
      ? Math.min(MAX_LAP_ROUNDS, Math.floor(bestLapRounds))
      : MAX_LAP_ROUNDS;
  const lapField = String(lap).padStart(10, '0');
  const roundsField = String(rounds).padStart(6, '0');
  return `${w}#${lapField}#${roundsField}#${key}`;
}

/** Same ordering as buildRankKey — used to sort Top 10 in memory (covers stale keys). */
export function compareLeaderboardEntries(
  a: Pick<Top10Entry, 'wins' | 'bestLapMs' | 'bestLapRounds' | 'nickname'>,
  b: Pick<Top10Entry, 'wins' | 'bestLapMs' | 'bestLapRounds' | 'nickname'>
): number {
  if (b.wins !== a.wins) return b.wins - a.wins;
  const aLap = a.bestLapMs ?? Number.POSITIVE_INFINITY;
  const bLap = b.bestLapMs ?? Number.POSITIVE_INFINITY;
  if (aLap !== bLap) return aLap - bLap;
  const aRounds = a.bestLapRounds ?? Number.POSITIVE_INFINITY;
  const bRounds = b.bestLapRounds ?? Number.POSITIVE_INFINITY;
  if (aRounds !== bRounds) return aRounds - bRounds;
  return a.nickname.localeCompare(b.nickname);
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
 * rankKey is rewritten last so it always reflects the final wins + bests.
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

  const afterCounters = await ddb.send(
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

  let item = afterCounters.Attributes as LeaderboardRecord | undefined;

  if (delta.bestLapMs !== undefined) {
    try {
      const afterLap = await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { nicknameKey: key },
          UpdateExpression: 'SET bestLapMs = :lap, updatedAt = :now',
          ConditionExpression: 'attribute_not_exists(bestLapMs) OR bestLapMs > :lap',
          ExpressionAttributeValues: { ':lap': delta.bestLapMs, ':now': now },
          ReturnValues: 'ALL_NEW',
        })
      );
      item = afterLap.Attributes as LeaderboardRecord | undefined;
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    }
  }

  if (delta.bestLapRounds !== undefined) {
    try {
      const afterRounds = await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { nicknameKey: key },
          UpdateExpression: 'SET bestLapRounds = :rounds, updatedAt = :now',
          ConditionExpression: 'attribute_not_exists(bestLapRounds) OR bestLapRounds > :rounds',
          ExpressionAttributeValues: { ':rounds': delta.bestLapRounds, ':now': now },
          ReturnValues: 'ALL_NEW',
        })
      );
      item = afterRounds.Attributes as LeaderboardRecord | undefined;
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    }
  }

  const wins = item?.wins ?? delta.wins;
  const bestLapMs = item?.bestLapMs;
  const bestLapRounds = item?.bestLapRounds;

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { nicknameKey: key },
      UpdateExpression: 'SET rankKey = :rk, updatedAt = :now',
      ExpressionAttributeValues: {
        ':rk': buildRankKey(wins, bestLapMs, bestLapRounds, key),
        ':now': now,
      },
    })
  );
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
  // Pull a wider window than Top N so in-memory re-sort can correct entries
  // that still carry a pre-migration rankKey (wins/podiums only).
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'BoardRankIndex',
      KeyConditionExpression: 'board = :board',
      ExpressionAttributeValues: { ':board': BOARD },
      ScanIndexForward: true,
      Limit: 50,
    })
  );

  const entries = ((result.Items ?? []) as LeaderboardRecord[]).map((row) => ({
    nickname: row.displayName || row.nicknameKey,
    races: row.races ?? 0,
    wins: row.wins ?? 0,
    podiums: row.podiums ?? 0,
    bestLapMs: row.bestLapMs,
    bestLapRounds: row.bestLapRounds,
  }));

  entries.sort(compareLeaderboardEntries);
  return entries.slice(0, TOP_N);
}
