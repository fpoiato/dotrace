import { GameState, Player, isAiPilotNickname, isTimedMode } from '../../core/models/ws-types';

/** How long a turn may sit before we call it stuck. */
export const TURN_STALL_MS = 5_000;

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
