import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

/**
 * Aggregate race counter. One item, no screen.
 * started = green flags, finished = races that reached GAME_OVER,
 * averageDurationMs = mean wall-clock of finished races that reported a duration.
 * Marker items keep a host retry from counting the same race twice.
 * Neither item sets `board`, so the Top 10 query never sees them.
 */
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const RACE_COUNTER_KEY = 'meta#race-counter';
/** Ignore a stuck tab so one abandoned clock cannot dominate the average. */
export const MAX_RACE_DURATION_MS = 6 * 60 * 60 * 1000;

function tableName(): string {
  return process.env.LEADERBOARD_TABLE ?? '';
}

export function raceMarkerKey(roomCode: string, raceStartedAt: number): string | null {
  const code = roomCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(code)) return null;
  if (!Number.isFinite(raceStartedAt)) return null;
  const started = Math.floor(raceStartedAt);
  if (started < 1_000_000_000_000) return null;
  return `race#${code}#${started}`;
}

/** Usable wall-clock, or null when the sample must not enter the average. */
export function clampRaceDurationMs(ms: number): number | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const n = Math.floor(ms);
  if (n > MAX_RACE_DURATION_MS) return null;
  return n;
}

export function averageDurationMs(totalDurationMs: number, samples: number): number {
  if (!Number.isFinite(totalDurationMs) || !Number.isFinite(samples) || samples <= 0) return 0;
  return Math.round(totalDurationMs / samples);
}

function alreadyRecorded(err: unknown): boolean {
  const name = (err as { name?: string }).name ?? '';
  if (name === 'TransactionCanceledException' || name === 'ConditionalCheckFailedException') {
    return true;
  }
  const reasons = (err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return Array.isArray(reasons) && reasons.some((reason) => reason.Code === 'ConditionalCheckFailed');
}

async function refreshAverage(now: number): Promise<void> {
  const got = await ddb.send(
    new GetCommand({
      TableName: tableName(),
      Key: { nicknameKey: RACE_COUNTER_KEY },
    })
  );
  const samples = Number(got.Item?.durationSamples ?? 0);
  const total = Number(got.Item?.totalDurationMs ?? 0);
  await ddb.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { nicknameKey: RACE_COUNTER_KEY },
      UpdateExpression: 'SET averageDurationMs = :avg, updatedAt = :now',
      ExpressionAttributeValues: {
        ':avg': averageDurationMs(total, samples),
        ':now': now,
      },
    })
  );
}

/** Count a green flag once per room + start timestamp. */
export async function recordRaceStarted(roomCode: string, raceStartedAt: number): Promise<boolean> {
  const marker = raceMarkerKey(roomCode, raceStartedAt);
  if (!marker) return false;
  const now = Date.now();
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName(),
              Item: {
                nicknameKey: marker,
                kind: 'race-marker',
                roomCode: roomCode.trim().toUpperCase(),
                raceStartedAt: Math.floor(raceStartedAt),
                updatedAt: now,
              },
              ConditionExpression: 'attribute_not_exists(nicknameKey)',
            },
          },
          {
            Update: {
              TableName: tableName(),
              Key: { nicknameKey: RACE_COUNTER_KEY },
              UpdateExpression: 'ADD started :one SET updatedAt = :now, kind = :kind',
              ExpressionAttributeValues: {
                ':one': 1,
                ':now': now,
                ':kind': 'race-counter',
              },
            },
          },
        ],
      })
    );
    return true;
  } catch (err) {
    if (alreadyRecorded(err)) return false;
    throw err;
  }
}

/**
 * Count a finish once and fold its duration into the average.
 * A finish whose start was never stored still counts as started.
 */
export async function recordRaceFinished(
  roomCode: string,
  raceStartedAt: number,
  durationMs: number
): Promise<boolean> {
  const marker = raceMarkerKey(roomCode, raceStartedAt);
  const duration = clampRaceDurationMs(durationMs);
  if (!marker || duration === null) return false;
  await recordRaceStarted(roomCode, raceStartedAt);
  const now = Date.now();
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName(),
              Key: { nicknameKey: marker },
              UpdateExpression:
                'SET finishedAt = :now, durationMs = :dur, kind = :kind, updatedAt = :now',
              ConditionExpression: 'attribute_not_exists(finishedAt)',
              ExpressionAttributeValues: {
                ':now': now,
                ':dur': duration,
                ':kind': 'race-marker',
              },
            },
          },
          {
            Update: {
              TableName: tableName(),
              Key: { nicknameKey: RACE_COUNTER_KEY },
              UpdateExpression:
                'ADD finished :one, durationSamples :one, totalDurationMs :dur SET updatedAt = :now, kind = :kind',
              ExpressionAttributeValues: {
                ':one': 1,
                ':dur': duration,
                ':now': now,
                ':kind': 'race-counter',
              },
            },
          },
        ],
      })
    );
  } catch (err) {
    if (alreadyRecorded(err)) return false;
    throw err;
  }
  await refreshAverage(now);
  return true;
}
