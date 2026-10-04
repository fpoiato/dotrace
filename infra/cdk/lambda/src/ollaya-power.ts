/**
 * Start the Ollaya EC2 when a room has players, and stop it after the room
 * has been empty for a few minutes. The public IP changes on every start, so
 * the current base URL is published to SSM for the AI player Lambda.
 *
 * Temporary copy. The shared controller lives in fpoiato/laya-host (`LayaPower`).
 * This function remains until the pipeline detaches the host from this stack.
 */
import {
  DescribeInstancesCommand,
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
} from '@aws-sdk/client-ec2';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { countLiveSockets, getOllayaControl } from './lib/ddb';

const IDLE_MS = Number(process.env.OLLAYA_IDLE_MS ?? 180_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface OllayaPowerEvent {
  action: 'start' | 'stop';
  generation: number;
}

export function stopStillValid(input: {
  eventGeneration: number;
  currentGeneration: number;
  desired: string;
  liveSockets: number;
}): boolean {
  return (
    input.eventGeneration === input.currentGeneration &&
    input.desired === 'stopped' &&
    input.liveSockets === 0
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
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

async function publishUrl(ip: string): Promise<string> {
  const url = `http://${ip}:11435`;
  await new SSMClient({}).send(
    new PutParameterCommand({
      Name: requireEnv('OLLAYA_URL_PARAMETER'),
      Value: url,
      Type: 'String',
      Overwrite: true,
    })
  );
  return url;
}

async function clearUrl(): Promise<void> {
  await new SSMClient({}).send(
    new PutParameterCommand({
      Name: requireEnv('OLLAYA_URL_PARAMETER'),
      Value: 'pending',
      Type: 'String',
      Overwrite: true,
    })
  );
}

async function apiKey(): Promise<string | undefined> {
  const secretId = process.env.OLLAYA_API_KEY_SECRET;
  if (!secretId) return undefined;
  const out = await new SecretsManagerClient({}).send(
    new GetSecretValueCommand({ SecretId: secretId })
  );
  return out.SecretString;
}

/** Load the model once so the first race turn does not pay the cold start. */
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
      model: process.env.OLLAYA_MODEL || 'laya:typed-decisions',
      state: 'Dot Race warmup.',
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

export const handler = async (event: OllayaPowerEvent): Promise<void> => {
  const instanceId = requireEnv('OLLAYA_INSTANCE_ID');
  const ec2 = new EC2Client({});

  if (event.action === 'start') {
    console.log(`[OLLAYA] start gen=${event.generation} instance=${instanceId}`);
    const ip = await waitForPublicIp(ec2, instanceId);
    const url = await publishUrl(ip);
    try {
      await warm(url);
      console.log(`[OLLAYA] ready ${url}`);
    } catch (err) {
      console.warn('[OLLAYA] warmup failed; the bot will use the heuristic until decide works:', err instanceof Error ? err.message : err);
    }
    return;
  }

  console.log(`[OLLAYA] stop requested gen=${event.generation}; waiting ${IDLE_MS}ms`);
  await sleep(IDLE_MS);
  const control = await getOllayaControl();
  const liveSockets = await countLiveSockets();
  if (
    !stopStillValid({
      eventGeneration: event.generation,
      currentGeneration: control.generation,
      desired: control.desired,
      liveSockets,
    })
  ) {
    console.log(
      `[OLLAYA] stop cancelled gen=${event.generation} current=${control.generation} desired=${control.desired} live=${liveSockets}`
    );
    return;
  }
  await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
  await clearUrl();
  console.log(`[OLLAYA] stopped ${instanceId}`);
};
