/**
 * Start the shared Ollaya EC2, or stop it after it has been idle.
 *
 * Two callers are supported:
 * - Legacy (Dot Race, unchanged): `{ action, generation }` and the generation
 *   lives in the Dot Race connections table. The instance stops only when that
 *   request is still current, the room is empty, and no other project holds a lease.
 * - Any other project: `{ action, consumer, generation }` after bumping its
 *   own row in the Laya control table. See client/request-power.ts.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DescribeInstancesCommand,
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
} from '@aws-sdk/client-ec2';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DEFAULT_IDLE_MS, DEFAULT_MODEL, DEFAULT_PORT, LEGACY_CONSUMER } from '../../lib/contract';
import { countLiveSockets, readLegacyControl } from './legacy';
import { Lease, legacyIsActive, otherActiveConsumers, requesterIsIdle, shouldStop } from './policy';

const IDLE_MS = Number(process.env.LAYA_IDLE_MS ?? DEFAULT_IDLE_MS);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export interface LayaPowerEvent {
  action: 'start' | 'stop';
  /** Project id. Omitted for the Dot Race payload. */
  consumer?: string;
  generation?: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function legacyUrlNames(): string[] {
  return (process.env.LEGACY_URL_PARAMETERS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function urlParameterNames(): string[] {
  return [requireEnv('LAYA_URL_PARAMETER'), ...legacyUrlNames()];
}

async function putUrl(value: string): Promise<void> {
  const ssm = new SSMClient({});
  for (const name of urlParameterNames()) {
    await ssm.send(
      new PutParameterCommand({
        Name: name,
        Value: value,
        Type: 'String',
        Overwrite: true,
      })
    );
  }
}

async function waitForPublicIp(ec2: EC2Client, instanceId: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const desc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const instance = desc.Reservations?.[0]?.Instances?.[0];
    const state = instance?.State?.Name;
    const ip = instance?.PublicIpAddress;
    if (state === 'running' && ip) return ip;
    if (state === 'stopped') {
      await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
    }
    await sleep(5_000);
  }
  throw new Error(`Instance ${instanceId} did not receive a public IP`);
}

async function apiKey(): Promise<string | undefined> {
  const secretId = process.env.LAYA_API_KEY_SECRET;
  if (!secretId) return undefined;
  const out = await new SecretsManagerClient({}).send(
    new GetSecretValueCommand({ SecretId: secretId })
  );
  return out.SecretString;
}

/** Load the model once so the first decision does not pay the cold start. */
async function warm(url: string): Promise<void> {
  const key = await apiKey();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  for (let attempt = 0; attempt < 24; attempt++) {
    try {
      const health = await fetch(`${url}/`, { signal: AbortSignal.timeout(3_000) });
      if (health.ok) break;
    } catch {
      await sleep(5_000);
    }
  }
  const response = await fetch(`${url}/api/decide`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: process.env.LAYA_MODEL ?? DEFAULT_MODEL,
      state: 'Laya warmup.',
      questions: {
        ready: { type: 'noul', instructions: 'The service is ready.' },
      },
      keep_alive: '-1',
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`warmup ${response.status}: ${text.slice(0, 180)}`);
  }
}

async function readLeases(): Promise<Lease[]> {
  const tableName = process.env.LAYA_CONTROL_TABLE;
  if (!tableName) return [];
  const leases: Lease[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: 'consumer, generation, desired',
        ExclusiveStartKey: startKey,
      })
    );
    for (const item of result.Items ?? []) {
      const row = item as { consumer?: string; generation?: number; desired?: string };
      if (!row.consumer) continue;
      leases.push({
        consumer: row.consumer,
        generation: Number(row.generation ?? 0),
        desired: row.desired ?? '',
      });
    }
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return leases;
}

export const handler = async (event: LayaPowerEvent): Promise<void> => {
  const instanceId = requireEnv('LAYA_INSTANCE_ID');
  const ec2 = new EC2Client({});
  const consumer = event.consumer?.trim() || LEGACY_CONSUMER;
  const legacy = !event.consumer?.trim();

  if (event.action === 'start') {
    console.log(`[LAYA] start consumer=${consumer} gen=${event.generation ?? '-'} instance=${instanceId}`);
    const ip = await waitForPublicIp(ec2, instanceId);
    const url = `http://${ip}:${process.env.LAYA_PORT ?? DEFAULT_PORT}`;
    await putUrl(url);
    try {
      await warm(url);
      console.log(`[LAYA] ready ${url}`);
    } catch (err) {
      console.warn(
        '[LAYA] warmup failed; callers keep their own fallback until decide works:',
        err instanceof Error ? err.message : err
      );
    }
    return;
  }

  console.log(`[LAYA] stop requested consumer=${consumer} gen=${event.generation ?? '-'}; waiting ${IDLE_MS}ms`);
  await sleep(IDLE_MS);

  const leases = await readLeases();
  const ownLease = leases.find((lease) => lease.consumer === consumer);
  const legacyTable = process.env.LEGACY_CONNECTIONS_TABLE;
  let legacyControl = undefined;
  let liveSockets = 0;
  if (legacyTable) {
    legacyControl = await readLegacyControl(legacyTable);
    liveSockets = await countLiveSockets(legacyTable);
  } else if (legacy) {
    console.warn('[LAYA] legacy stop ignored; LEGACY_CONNECTIONS_TABLE is not set');
    return;
  }

  const requesterIdle = requesterIsIdle({
    legacy,
    eventGeneration: event.generation,
    legacyControl,
    liveSockets,
    ownLease,
  });
  const others = otherActiveConsumers({
    requester: consumer,
    leases,
    legacyActive: legacyTable ? legacyIsActive(legacyControl, liveSockets) : false,
  });
  if (!shouldStop(requesterIdle, others)) {
    console.log(
      `[LAYA] stop cancelled consumer=${consumer} idle=${requesterIdle} others=${others.join(',') || '-'}`
    );
    return;
  }

  await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
  await putUrl('pending');
  console.log(`[LAYA] stopped ${instanceId}`);
};
