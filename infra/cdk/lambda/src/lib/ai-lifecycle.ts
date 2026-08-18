/**
 * Pure AI-worker lifecycle rules.
 *
 * The 2026-08-12 cost incident was 23 always-on 10-minute Lambdas that
 * self-invoked forever after humans left. These helpers encode the new
 * contract: seats are DynamoDB rows (no live socket); a worker runs one
 * turn then exits; handoff/self-invoke events are refused.
 */
import type { ConnectionRecord } from './ddb';
import { isAiSeat } from './ddb';
import {
  GameState,
  Player,
  canPlayerMove,
  isAiPilotNickname,
} from '../../../../../shared/ws-types';

export { isAiSeat, aiSeatId } from './ddb';
export const AI_SEAT_PREFIX = 'aiseat#';

export function isHumanConnection(record: Pick<ConnectionRecord, 'connectionId' | 'nickname'>): boolean {
  return !isAiSeat(record.connectionId) && !isAiPilotNickname(record.nickname);
}

export function roomHasHuman(
  connections: Pick<ConnectionRecord, 'connectionId' | 'nickname' | 'status'>[]
): boolean {
  return connections.some((c) => c.status === 'approved' && isHumanConnection(c));
}

/** SPAWN_AI_PLAYER must never start a worker — only create a lobby seat. */
export function shouldInvokeLambdaOnSpawn(): boolean {
  return false;
}

export function isHandoffResumeEvent(event: {
  previousConnectionId?: string;
  handoffGeneration?: number;
  state?: unknown;
}): boolean {
  return Boolean(event.previousConnectionId) || event.handoffGeneration !== undefined || !event.state;
}

export function aiTurnKey(state: GameState, playerId: string): string {
  const player = state.players.find((p) => p.connectionId === playerId);
  if (!player) return '';
  if (state.gameMode === 'TIMED') {
    return [
      'timed',
      state.round,
      playerId,
      player.position.x,
      player.position.y,
      player.velocity.x,
      player.velocity.y,
      player.lap,
    ].join(':');
  }
  return `turns:${state.round}:${state.currentTurnIndex}:${playerId}`;
}

export function shouldDispatchAiTurn(opts: {
  phase: GameState['phase'];
  stopped: boolean;
  hasHuman: boolean;
  canMove: boolean;
}): boolean {
  return opts.phase === 'GAME_ROUND' && !opts.stopped && opts.hasHuman && opts.canMove;
}

export function shouldRunAiWorker(opts: {
  isHandoffResume: boolean;
  eventHasState: boolean;
  stopped: boolean;
  seatExists: boolean;
  hasHuman: boolean;
  phase?: GameState['phase'];
  canMove: boolean;
}): { run: boolean; reason: string } {
  if (opts.isHandoffResume || !opts.eventHasState) {
    return { run: false, reason: 'refuse-handoff' };
  }
  if (!opts.seatExists || opts.stopped) {
    return { run: false, reason: 'stopped' };
  }
  if (!opts.hasHuman) {
    return { run: false, reason: 'no-human' };
  }
  if (opts.phase !== 'GAME_ROUND') {
    return { run: false, reason: 'not-racing' };
  }
  if (!opts.canMove) {
    return { run: false, reason: 'not-our-turn' };
  }
  return { run: true, reason: 'ok' };
}

/** Drop bulky fields so async Invoke stays well under the 256 KB payload cap. */
export function slimGameStateForAi(state: GameState): GameState {
  return {
    ...state,
    replayLog: [],
    sessionStats: undefined,
    players: state.players.map((p) => ({ ...p, trail: (p.trail ?? []).slice(-3) })),
  };
}

export function playerCanMove(state: GameState, playerId: string, now = Date.now()): boolean {
  return canPlayerMove(state, playerId, now);
}

export function findPlayer(state: GameState, playerId: string): Player | undefined {
  return state.players.find((p) => p.connectionId === playerId);
}
