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

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler } from '../lambda/src/http';
import {
  isReplayId,
  loadReplay,
  MAX_REPLAY_BYTES,
  newReplayId,
  normalizeReplayPayload,
  REPLAY_TTL_SECONDS,
  replayTtl,
  saveReplay,
  SharedReplayPayload,
} from '../lambda/src/lib/replays';

function sample(moves = 2): SharedReplayPayload {
  return {
    v: 1,
    t: 'monza',
    l: 3,
    m: 'TURNS',
    p: [
      { id: 'p0', n: 'You', c: '#EF4444', jo: 0, h: 1, fo: 1, fr: 40, fa: 1_700_000_000_000, d: 6 },
      { id: 'p1', n: 'Bot', c: '#3B82F6', jo: 1 },
    ],
    r: Array.from({ length: moves }, (_, i) => [i % 2, i, 10 + i, 4, 1, 0, i % 5 === 0 ? 1 : 0, 1]),
  };
}

describe('replay payload', () => {
  it('keeps a 3-lap log and drops unknown fields', () => {
    const raw = { ...sample(800), extra: true, p: [{ ...sample().p[0], nick: 'nope' }, sample().p[1]] };
    const normalized = normalizeReplayPayload(raw);
    expect(normalized?.r).toHaveLength(800);
    expect(normalized?.l).toBe(3);
    expect(normalized?.p[0]).toEqual(sample().p[0]);
    expect(Buffer.byteLength(JSON.stringify(normalized))).toBeLessThan(MAX_REPLAY_BYTES);
  });

  it('rejects a replay that is not a finished race', () => {
    expect(normalizeReplayPayload(null)).toBeNull();
    expect(normalizeReplayPayload({ ...sample(), v: 2 })).toBeNull();
    expect(normalizeReplayPayload({ ...sample(), l: 9 })).toBeNull();
    expect(normalizeReplayPayload({ ...sample(), m: 'ENDURANCE' })).toBeNull();
    expect(normalizeReplayPayload({ ...sample(), r: [] })).toBeNull();
    expect(normalizeReplayPayload({ ...sample(), r: [[9, 0, 0, 0, 0, 0, 0, 1]] })).toBeNull();
  });

  it('stamps a one-day ttl and a short id', () => {
    expect(replayTtl(1_700_000_000)).toBe(1_700_000_000 + REPLAY_TTL_SECONDS);
    expect(REPLAY_TTL_SECONDS).toBe(86_400);
    expect(isReplayId(newReplayId())).toBe(true);
    expect(isReplayId('short')).toBe(false);
  });
});

const saved = new Map<string, { payload: string; ttl: number }>();

function installReplayTable(): void {
  process.env.REPLAYS_TABLE = 'DotRaceReplays';
  saved.clear();
  holders.send.mockReset();
  holders.send.mockImplementation(async (command: unknown) => {
    if (command instanceof PutCommand) {
      const item = command.input.Item as { replayId: string; payload: string; ttl: number };
      if (saved.has(item.replayId)) {
        const err = new Error('exists');
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
      saved.set(item.replayId, { payload: item.payload, ttl: item.ttl });
      return {};
    }
    if (command instanceof GetCommand) {
      const id = command.input.Key?.replayId as string;
      const item = saved.get(id);
      return { Item: item ? { replayId: id, ...item } : undefined };
    }
    throw new Error('unexpected command');
  });
}

describe('replay store', () => {
  beforeEach(installReplayTable);

  it('saves only the id-sized handle and reads the race back', async () => {
    const now = Math.floor(Date.now() / 1000);
    const result = await saveReplay(sample(1200));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).toHaveLength(12);
    const loaded = await loadReplay(result.id);
    expect(loaded?.t).toBe('monza');
    expect(loaded?.l).toBe(3);
    expect(loaded?.r).toHaveLength(1200);
    const row = saved.get(result.id);
    expect(row?.ttl).toBeGreaterThanOrEqual(now + REPLAY_TTL_SECONDS - 2);
    expect(row?.ttl).toBeLessThanOrEqual(now + REPLAY_TTL_SECONDS + 2);
  });

  it('hides a replay once the one-day ttl has passed', async () => {
    const result = await saveReplay(sample());
    if (!result.ok) throw new Error('save failed');
    const row = saved.get(result.id)!;
    row.ttl = Math.floor(Date.now() / 1000) - 1;
    await expect(loadReplay(result.id)).resolves.toBeUndefined();
  });

  it('does not query dynamo for a malformed id', async () => {
    await expect(loadReplay('../etc')).resolves.toBeUndefined();
    expect(holders.send).not.toHaveBeenCalled();
  });
});

function httpEvent(
  method: string,
  path: string,
  body?: unknown,
  id?: string
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    requestContext: {
      accountId: '123456789012',
      apiId: 'api',
      domainName: 'example.com',
      domainPrefix: 'example',
      requestId: 'req',
      routeKey: `${method} ${path}`,
      stage: '$default',
      time: '',
      timeEpoch: 0,
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
    },
    pathParameters: id ? { id } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

describe('replay http', () => {
  beforeEach(installReplayTable);

  it('returns an id on save and the race on get', async () => {
    const created = await handler(httpEvent('POST', '/replays', sample(4)), {} as never, () => undefined);
    expect(created).toMatchObject({ statusCode: 201 });
    const id = JSON.parse((created as { body: string }).body).id as string;

    const fetched = await handler(
      httpEvent('GET', `/replays/${id}`, undefined, id),
      {} as never,
      () => undefined
    );
    expect(fetched).toMatchObject({ statusCode: 200 });
    const payload = JSON.parse((fetched as { body: string }).body) as SharedReplayPayload;
    expect(payload.t).toBe('monza');
    expect(payload.r).toHaveLength(4);
  });

  it('rejects an invalid body', async () => {
    const created = await handler(httpEvent('POST', '/replays', { v: 1 }), {} as never, () => undefined);
    expect(created).toMatchObject({ statusCode: 400 });
  });
});
