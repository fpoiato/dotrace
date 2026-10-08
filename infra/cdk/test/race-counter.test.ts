const holders: { send: jest.Mock } = { send: jest.fn() };

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: () => ({
        send: (command: unknown) => holders.send(command),
      }),
    },
  };
});

import { GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  averageDurationMs,
  clampRaceDurationMs,
  MAX_RACE_DURATION_MS,
  raceMarkerKey,
  recordRaceFinished,
  recordRaceStarted,
  RACE_COUNTER_KEY,
} from '../lambda/src/lib/race-counter';

describe('race counter', () => {
  beforeEach(() => {
    holders.send.mockReset();
    process.env.LEADERBOARD_TABLE = 'DotRaceLeaderboard';
  });

  it('builds a stable marker and rejects a bad clock', () => {
    expect(raceMarkerKey('ab12c', 1_700_000_000_000)).toBe('race#AB12C#1700000000000');
    expect(raceMarkerKey('nope', 1_700_000_000_000)).toBeNull();
    expect(raceMarkerKey('ABCDE', 100)).toBeNull();
    expect(clampRaceDurationMs(90_000)).toBe(90_000);
    expect(clampRaceDurationMs(-1)).toBeNull();
    expect(clampRaceDurationMs(MAX_RACE_DURATION_MS + 1)).toBeNull();
    expect(averageDurationMs(180_000, 2)).toBe(90_000);
    expect(averageDurationMs(180_000, 0)).toBe(0);
  });

  it('counts a start once and ignores the host retry', async () => {
    holders.send.mockResolvedValueOnce({});
    await expect(recordRaceStarted('abcde', 1_700_000_000_000)).resolves.toBe(true);
    const command = holders.send.mock.calls[0][0] as TransactWriteCommand;
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command.input.TransactItems?.[1]?.Update?.Key).toEqual({
      nicknameKey: RACE_COUNTER_KEY,
    });
    expect(command.input.TransactItems?.[1]?.Update?.UpdateExpression).toContain('ADD started');

    holders.send.mockRejectedValueOnce({ name: 'TransactionCanceledException' });
    await expect(recordRaceStarted('abcde', 1_700_000_000_000)).resolves.toBe(false);
  });

  it('counts a finish and stores the average duration', async () => {
    holders.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { durationSamples: 2, totalDurationMs: 180_000 } })
      .mockResolvedValueOnce({});

    await expect(recordRaceFinished('abcde', 1_700_000_000_000, 90_000)).resolves.toBe(true);

    const finish = holders.send.mock.calls[1][0] as TransactWriteCommand;
    expect(finish).toBeInstanceOf(TransactWriteCommand);
    expect(finish.input.TransactItems?.[1]?.Update?.UpdateExpression).toContain('ADD finished');

    const average = holders.send.mock.calls[3][0] as UpdateCommand;
    expect(average).toBeInstanceOf(UpdateCommand);
    expect(average.input.ExpressionAttributeValues?.[':avg']).toBe(90_000);
    expect(holders.send.mock.calls[2][0]).toBeInstanceOf(GetCommand);
  });
});
