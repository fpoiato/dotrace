/**
 * AI player runner.
 *
 * New pilots are seats, not sockets. The host posts PLAY_AI_TURN and this
 * function handles `action: PLAY_TURN`: read the seat, claim a short lease,
 * run the existing brain, and return one velocity. A repeat of the same token
 * returns the saved vector and does not call the model again.
 *
 * The socket race loop below stays for invocations that are already in flight
 * (spawn marker + 10 min handoff). New SPAWN_AI_PLAYER calls do not start it.
 *
 * Env: WS_URL, API_URL, CONNECTIONS_TABLE, BEDROCK_MODEL_ID, BRAIN,
 * AI_HANDOFF_AFTER_MS, BEDROCK_TIMEOUT_MS, MOVE_DELAY_MS (optional override).
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { raceLoop, RaceLoopResult } from '../../../../agent/src/agent';
import { BedrockBrain, HeuristicBrain, MoveBrain, applyPilotPolicy } from '../../../../agent/src/brain';
import { LayaBrain } from '../../../../agent/src/laya-brain';
import { DEFAULT_BEDROCK_MODEL_ID } from '../../../../agent/src/config';
import { LAYA_DECIDE_MODEL } from '../../../../agent/src/laya-scene';
import {
  AiDifficulty,
  DIFFICULTY_TUNING,
  difficultyFromUnknown,
} from '../../../../agent/src/difficulty';
import { GameSession } from '../../../../agent/src/session';
import { buildBoardSummary, listAnnotatedMoves } from '../../../../agent/src/tools';
import { HttpClient } from '../../../../bot/src/http-client';
import { WsClient } from '../../../../bot/src/ws-client';
import { getTrackById } from '../../../../shared/tracks';
import { GameState } from '../../../../shared/ws-types';
import {
  aiSeatId,
  claimAiSeat,
  classifySeatRead,
  ConnectionRecord,
  getConnection,
  putAiHandoffMarker,
  releaseSeat,
  saveSeatMove,
} from './lib/ddb';

/** Planned rotation — well under the 15 min hard cap. */
const DEFAULT_HANDOFF_AFTER_MS = 10 * 60 * 1000;
const REJOIN_RETRY_MS = 25_000;
const WAIT_SLICE_MS = 20_000;

export interface SpawnAiPlayerEvent {
  roomCode: string;
  nickname: string;
  brain?: 'bedrock' | 'heuristic' | 'laya';
  difficulty?: AiDifficulty | string;
  /** Set on planned rotation so the successor rejoins the same seat. */
  previousConnectionId?: string;
  handoffGeneration?: number;
  action?: undefined;
}

export interface PlayTurnEvent {
  action: 'PLAY_TURN';
  roomCode: string;
  nickname: string;
  token: string;
  state: GameState;
}

const PLAY_TURN_POLL_MS = 12_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let cachedUrl: { url: string; at: number } | undefined;
let cachedApiKey: Promise<string | undefined> | undefined;

function apiKey(): Promise<string | undefined> {
  const secretId = process.env.OLLAYA_API_KEY_SECRET;
  const fromEnv = process.env.OLLAYA_API_KEY;
  if (!secretId) return Promise.resolve(fromEnv);
  cachedApiKey ??= new SecretsManagerClient({})
    .send(new GetSecretValueCommand({ SecretId: secretId }))
    .then((out) => out.SecretString || fromEnv);
  return cachedApiKey;
}

/** URL written by the power Lambda after the instance has a public address. */
export async function resolveLayaEndpoint(): Promise<{ url: string; apiKey?: string } | null> {
  const direct = process.env.OLLAYA_URL?.trim();
  if (direct) return { url: direct, apiKey: await apiKey() };

  const name = process.env.OLLAYA_URL_PARAMETER;
  if (!name) return null;
  if (!cachedUrl || Date.now() - cachedUrl.at > 15_000) {
    const out = await new SSMClient({}).send(new GetParameterCommand({ Name: name }));
    const value = out.Parameter?.Value?.trim() ?? '';
    cachedUrl = { url: value.startsWith('http') ? value : '', at: Date.now() };
  }
  if (!cachedUrl.url) return null;
  return { url: cachedUrl.url, apiKey: await apiKey() };
}

function buildBrain(event: SpawnAiPlayerEvent, difficulty: AiDifficulty): MoveBrain {
  const mode = event.brain ?? process.env.BRAIN ?? 'heuristic';
  if (mode === 'laya') {
    console.log(`[AI] brain=laya nickname=${event.nickname} difficulty=${difficulty}`);
    return new LayaBrain({
      endpoint: resolveLayaEndpoint,
      onFailure: () => {
        cachedUrl = undefined;
      },
      fallbackSeed: event.nickname,
      difficulty,
      model: process.env.OLLAYA_MODEL || LAYA_DECIDE_MODEL,
      timeoutMs: Number(process.env.LAYA_TIMEOUT_MS ?? 2_500),
    });
  }
  if (mode === 'bedrock') {
    console.log(`[AI] brain=bedrock nickname=${event.nickname} difficulty=${difficulty}`);
    return new BedrockBrain({
      modelId: process.env.BEDROCK_MODEL_ID ?? DEFAULT_BEDROCK_MODEL_ID,
      region: process.env.AWS_REGION ?? 'us-east-1',
      fallbackSeed: event.nickname,
      difficulty,
      timeoutMs: Number(process.env.BEDROCK_TIMEOUT_MS ?? 20_000),
    });
  }
  console.log(`[AI] brain=heuristic nickname=${event.nickname} difficulty=${difficulty}`);
  return new HeuristicBrain({ styleOrSeed: event.nickname, difficulty });
}

async function waitVoidSliced(
  wait: (timeoutMs: number) => Promise<void>,
  sliceMs: number,
  shouldHandoff: () => boolean
): Promise<'ok' | 'handoff'> {
  for (;;) {
    if (shouldHandoff()) return 'handoff';
    try {
      await wait(sliceMs);
      return 'ok';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/Timed out/i.test(msg)) throw err;
    }
  }
}

async function enterSession(
  session: GameSession,
  previousConnectionId?: string
): Promise<void> {
  if (!previousConnectionId) {
    await session.join();
    return;
  }

  const deadline = Date.now() + REJOIN_RETRY_MS;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await session.rejoinWithPrevious(previousConnectionId);
      if (session.getSnapshot().status === 'approved') return;
      lastErr = new Error(`rejoin status=${session.getSnapshot().status}`);
    } catch (err) {
      lastErr = err;
      console.warn(
        '[AI] Handoff rejoin retry:',
        err instanceof Error ? err.message : err
      );
    }
    await sleep(800);
  }
  throw lastErr instanceof Error ? lastErr : new Error('Handoff rejoin failed');
}

async function invokeSuccessor(event: SpawnAiPlayerEvent): Promise<void> {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!functionName) {
    throw new Error('AWS_LAMBDA_FUNCTION_NAME is not set — cannot handoff');
  }
  const client = new LambdaClient({});
  await client.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(event)),
    })
  );
}

async function performHandoff(event: SpawnAiPlayerEvent, session: GameSession): Promise<void> {
  const previousConnectionId = session.getSnapshot().connectionId;
  if (!previousConnectionId) {
    console.warn('[AI] Handoff skipped — no connectionId');
    session.leave();
    return;
  }
  const roomCode = event.roomCode.toUpperCase();
  await putAiHandoffMarker(roomCode, event.nickname, previousConnectionId);
  session.leave();
  const generation = (event.handoffGeneration ?? 0) + 1;
  console.log(
    `[AI] Handing off gen=${generation} previous=${previousConnectionId} room=${roomCode}`
  );
  await invokeSuccessor({
    ...event,
    roomCode,
    previousConnectionId,
    handoffGeneration: generation,
  });
}

interface CachedMove {
  x: number;
  y: number;
  drs?: boolean;
  ers?: boolean;
}

function cachedVelocity(seat: ConnectionRecord | undefined, token: string): CachedMove | null {
  if (classifySeatRead(seat, token) !== 'cached' || !seat) return null;
  return {
    x: seat.lastVx as number,
    y: seat.lastVy as number,
    drs: seat.lastDrs === true,
    ers: seat.lastErs === true,
  };
}

async function pollCachedMove(
  connectionId: string,
  token: string,
  budgetMs: number
): Promise<CachedMove | null> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await sleep(250);
    const hit = cachedVelocity(await getConnection(connectionId), token);
    if (hit) return hit;
  }
  return null;
}

async function computeMove(
  seat: ConnectionRecord,
  state: GameState,
  nickname: string
): Promise<CachedMove> {
  const track = getTrackById(state.trackId);
  if (!track) throw new Error(`Unknown track ${state.trackId}`);
  const player = state.players.find(
    (candidate) => candidate.nickname.trim().toLowerCase() === nickname.trim().toLowerCase()
  );
  if (!player) throw new Error('AI player missing from board');
  const moves = listAnnotatedMoves(player, state, track);
  if (moves.length === 0) throw new Error('No legal moves');
  const difficulty = difficultyFromUnknown(seat.difficulty);
  const brain = buildBrain(
    { roomCode: seat.roomCode, nickname: seat.nickname, brain: seat.brain, difficulty },
    difficulty
  );
  const summary = buildBoardSummary(player, state, track);
  const chosen = await applyPilotPolicy(summary, moves, await brain.pickMove(summary, moves));
  return {
    x: chosen.velocity.x,
    y: chosen.velocity.y,
    drs: !!chosen.drs,
    ers: !!chosen.ers,
  };
}

export async function playTurn(
  event: PlayTurnEvent
): Promise<{ velocity: { x: number; y: number }; drs?: boolean; ers?: boolean }> {
  if (!event?.roomCode || !event.nickname || !event.token || !event.state) {
    throw new Error('roomCode, nickname, token, and state are required');
  }
  const id = aiSeatId(event.roomCode, event.nickname);
  const seat = await getConnection(id);
  if (!seat || seat.roomCode !== event.roomCode.toUpperCase()) {
    throw new Error('Unknown AI seat');
  }
  const ready = cachedVelocity(seat, event.token);
  if (ready) return { velocity: { x: ready.x, y: ready.y }, drs: ready.drs, ers: ready.ers };

  const claim = await claimAiSeat(id, event.token);
  if (claim === 'cached') {
    const again = cachedVelocity(await getConnection(id), event.token);
    if (again) return { velocity: { x: again.x, y: again.y }, drs: again.drs, ers: again.ers };
    throw new Error('AI seat cache missing');
  }
  if (claim === 'busy') {
    const waited = await pollCachedMove(id, event.token, PLAY_TURN_POLL_MS);
    if (waited) return { velocity: { x: waited.x, y: waited.y }, drs: waited.drs, ers: waited.ers };
    throw new Error('AI seat busy');
  }

  try {
    const velocity = await computeMove(seat, event.state, event.nickname);
    await saveSeatMove(id, event.token, velocity);
    console.log(
      `[AI] turn room=${seat.roomCode} nick=${seat.nickname} velocity=(${velocity.x},${velocity.y}) ` +
        `drs=${!!velocity.drs} ers=${!!velocity.ers}`
    );
    return { velocity: { x: velocity.x, y: velocity.y }, drs: velocity.drs, ers: velocity.ers };
  } catch (err) {
    await releaseSeat(id, event.token);
    throw err;
  }
}

export const handler = async (
  event: SpawnAiPlayerEvent | PlayTurnEvent
): Promise<{ velocity: { x: number; y: number }; drs?: boolean; ers?: boolean } | void> => {
  if (event && (event as PlayTurnEvent).action === 'PLAY_TURN') {
    return playTurn(event as PlayTurnEvent);
  }
  return runSocketRace(event as SpawnAiPlayerEvent);
};

async function runSocketRace(event: SpawnAiPlayerEvent): Promise<void> {
  const wsUrl = process.env.WS_URL;
  const apiUrl = process.env.API_URL;
  if (!wsUrl || !apiUrl) {
    throw new Error('WS_URL and API_URL must be configured');
  }
  if (!event?.roomCode || !event?.nickname) {
    throw new Error('roomCode and nickname are required');
  }

  const difficulty = difficultyFromUnknown(event.difficulty);
  const envDelay = process.env.MOVE_DELAY_MS;
  const moveDelayMs = envDelay
    ? Number(envDelay)
    : DIFFICULTY_TUNING[difficulty].moveDelayMs;
  const handoffAfterMs = Number(process.env.AI_HANDOFF_AFTER_MS ?? DEFAULT_HANDOFF_AFTER_MS);
  const startedAt = Date.now();
  const shouldHandoff = () => Date.now() - startedAt >= handoffAfterMs;
  const isResume = Boolean(event.previousConnectionId);

  const session = new GameSession(
    new WsClient(wsUrl),
    new HttpClient(apiUrl.replace(/\/$/, '')),
    event.roomCode.toUpperCase(),
    event.nickname
  );

  console.log(
    `[AI] ${isResume ? 'Resuming' : 'Joining'} room ${event.roomCode} as ${event.nickname} ` +
      `brain=${event.brain ?? process.env.BRAIN ?? 'heuristic'} difficulty=${difficulty} ` +
      `gen=${event.handoffGeneration ?? 0}`
  );

  let handedOff = false;
  try {
    await enterSession(session, event.previousConnectionId);

    if (!isResume) {
      const approval = await waitVoidSliced(
        (ms) => session.waitForApproval(ms),
        WAIT_SLICE_MS,
        shouldHandoff
      );
      if (approval === 'handoff') {
        await performHandoff(event, session);
        handedOff = true;
        return;
      }
    }

    console.log('[AI] Approved — waiting for race / racing');
    const result: RaceLoopResult = await raceLoop(
      session,
      buildBrain(event, difficulty),
      moveDelayMs,
      { shouldHandoff, waitSliceMs: WAIT_SLICE_MS }
    );
    if (result === 'handoff') {
      await performHandoff(event, session);
      handedOff = true;
      return;
    }
    console.log('[AI] Race finished');
  } finally {
    if (!handedOff) session.leave();
  }
};
