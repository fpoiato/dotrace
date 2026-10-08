import { GameState, Player, isAiPilotNickname, isTimedMode } from '../../core/models/ws-types';

/** How long a human turn may sit before we call it stuck. */
export const TURN_STALL_MS = 5_000;

/**
 * A bot seat is thinking, not stuck, for a short beat. Longer than this the
 * waiter must see the wake button — a hung AI request used to hide it for 30s.
 */
export const BOT_STALL_MS = 6_000;

/** Countdown shown to the human who should move. */
export const PLAY_NOW_SECONDS = 5;

/** Stable id for the seat that must move. Null outside a turn race. */
export function turnStallKey(state: GameState | null): string | null {
  if (!state || state.phase !== 'GAME_ROUND' || isTimedMode(state)) return null;
  const seat = state.turnOrder[state.currentTurnIndex];
  if (!seat) return null;
  return `${state.round}:${state.currentTurnIndex}:${seat}`;
}

/** Lobby bots and on-demand `ai#` seats. Humans never match. */
export function isBotPlayer(player: Player | null | undefined): boolean {
  if (!player) return false;
  return player.connectionId.startsWith('ai#') || isAiPilotNickname(player.nickname);
}

/** Wake button waits longer when the seat on the clock is a bot. */
export function stallWindowMs(player: Player | null | undefined): number {
  return isBotPlayer(player) ? BOT_STALL_MS : TURN_STALL_MS;
}
