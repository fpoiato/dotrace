/**
 * AI player worker — one short invoke per AI turn.
 *
 * Host RELAY of GAME_ROUND state (when an AI seat can move) invokes this
 * function asynchronously with a game-state snapshot. The worker picks a
 * legal velocity and FORWARD_TO_HOSTs it, then returns. It never holds a
 * WebSocket, never sleeps for minutes, and never self-invokes.
 *
 * Handoff/resume events from the old 10-minute worker are refused so a
 * leftover recycle cannot recreate the 2026-08-12 cost incident.
 */
import { BedrockBrain, HeuristicBrain, MoveBrain } from '../../../../agent/src/brain';
import {
  AiDifficulty,
  DIFFICULTY_TUNING,
  difficultyFromUnknown,
} from '../../../../agent/src/difficulty';
import { buildBoardSummary, listAnnotatedMoves } from '../../../../agent/src/tools';
import { getTrackById } from '../../../../shared/tracks';
import { GameState, Vector2D } from '../../../../shared/ws-types';
import { HttpClient } from '../../../../bot/src/http-client';
import { getApprovedConnections, getConnection, isAiSeat } from './lib/ddb';
import {
  findPlayer,
  isHandoffResumeEvent,
  playerCanMove,
  roomHasHuman,
  shouldRunAiWorker,
} from './lib/ai-lifecycle';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AiTurnEvent {
  roomCode: string;
  nickname: string;
  connectionId: string;
  brain?: 'bedrock' | 'heuristic';
  difficulty?: AiDifficulty | string;
  state?: GameState;
  /** Legacy 10-minute worker fields — if present, refuse and exit. */
  previousConnectionId?: string;
  handoffGeneration?: number;
}

function buildBrain(event: AiTurnEvent, difficulty: AiDifficulty): MoveBrain {
  const mode = event.brain ?? process.env.BRAIN ?? 'heuristic';
  if (mode === 'bedrock') {
    console.log(`[AI] brain=bedrock nickname=${event.nickname} difficulty=${difficulty}`);
    return new BedrockBrain({
      modelId: process.env.BEDROCK_MODEL_ID ?? 'amazon.nova-micro-v1:0',
      region: process.env.AWS_REGION ?? 'us-east-1',
      fallbackSeed: event.nickname,
      difficulty,
      timeoutMs: Number(process.env.BEDROCK_TIMEOUT_MS ?? 12_000),
    });
  }
  console.log(`[AI] brain=heuristic nickname=${event.nickname} difficulty=${difficulty}`);
  return new HeuristicBrain({ styleOrSeed: event.nickname, difficulty });
}

export const handler = async (event: AiTurnEvent): Promise<void> => {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error('API_URL must be configured');
  }
  if (!event?.roomCode || !event?.nickname || !event?.connectionId) {
    throw new Error('roomCode, nickname, and connectionId are required');
  }

  const isHandoffResume = isHandoffResumeEvent(event);
  const seat = await getConnection(event.connectionId);
  const connections = await getApprovedConnections(event.roomCode);
  const state = event.state;
  const canMove = Boolean(state && playerCanMove(state, event.connectionId));
  const decision = shouldRunAiWorker({
    isHandoffResume,
    eventHasState: Boolean(state),
    stopped: Boolean(seat?.aiStopped) || !seat,
    seatExists: Boolean(seat && isAiSeat(seat.connectionId)),
    hasHuman: roomHasHuman(connections),
    phase: state?.phase,
    canMove,
  });

  if (!decision.run) {
    console.log(
      `[AI] Exit without work reason=${decision.reason} room=${event.roomCode} nick=${event.nickname}`
    );
    return;
  }

  const player = findPlayer(state!, event.connectionId);
  const track = state!.trackId ? getTrackById(state!.trackId) : undefined;
  if (!player || !track) {
    console.warn('[AI] Missing player or track — exit');
    return;
  }

  const difficulty = difficultyFromUnknown(event.difficulty ?? seat?.difficulty);
  const envDelay = process.env.MOVE_DELAY_MS;
  const moveDelayMs = envDelay
    ? Number(envDelay)
    : DIFFICULTY_TUNING[difficulty].moveDelayMs;

  const summary = buildBoardSummary(player, state!, track);
  const moves = listAnnotatedMoves(player, state!, track);
  if (moves.length === 0) {
    console.warn('[AI] No legal moves — exit');
    return;
  }

  const chosen = await buildBrain(event, difficulty).pickMove(summary, moves);
  const vector: Vector2D = chosen.velocity;

  if (moveDelayMs > 0) {
    await sleep(Math.min(moveDelayMs, 2_000));
  }

  // Re-check before submit: human may have left during Bedrock latency.
  const stillThere = await getConnection(event.connectionId);
  const stillHumans = roomHasHuman(await getApprovedConnections(event.roomCode));
  if (!stillThere || stillThere.aiStopped || !stillHumans) {
    console.log('[AI] Cancelled before submit — room empty or seat stopped');
    return;
  }

  const http = new HttpClient(apiUrl.replace(/\/$/, ''));
  await http.postAction(
    'FORWARD_TO_HOST',
    { action: 'SUBMIT_MOVE', vector },
    event.connectionId,
    event.roomCode
  );
  console.log(
    `[AI] Submitted round=${state!.round} nick=${event.nickname} v=(${vector.x},${vector.y})`
  );
};
