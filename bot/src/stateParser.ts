/**
 * stateParser.ts — Inbound RELAY payload → structured ParsedTurn.
 *
 * Responsibility: validate that it is actually our turn, locate the bot's
 * Player record in the state, and resolve the TrackDefinition so the brain
 * receives clean, typed inputs instead of raw JSON.
 *
 * Nothing here computes moves — all physics / pathfinding lives in botBrain.
 */

import type { GameState, Player, TrackDefinition } from '../../shared/ws-types';
import { canPlayerMove } from '../../shared/ws-types';
import { getTrackById } from '../../shared/tracks';

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Everything the bot brain needs to decide its next move, pre-validated and
 * fully typed.
 */
export interface ParsedTurn {
  /** The bot's own Player record (position, velocity, off-track flag …). */
  myPlayer: Player;
  /** Full authoritative game snapshot delivered by the host. */
  gameState: GameState;
  /** Resolved TrackDefinition (grid, finish stripe, checkpoint zone …). */
  track: TrackDefinition;
  /** All other active racers — used for collision avoidance. */
  otherPlayers: Player[];
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse a raw RELAY payload received from the server.
 *
 * Returns `null` whenever the bot should NOT submit a move:
 *   - Game is not in the GAME_ROUND phase
 *   - It is not our turn (or TIMED mode but we are already finished)
 *   - The bot's Player record is missing (race not started yet)
 *   - The trackId does not resolve to a known circuit
 */
export function parseRelayPayload(
  payload: unknown,
  myConnectionId: string
): ParsedTurn | null {
  const relay = payload as { type?: string; state?: GameState } | null;

  if (!relay?.state) {
    console.warn('[STATE PARSER] RELAY payload has no state — skipping');
    return null;
  }

  const state: GameState = relay.state;

  // Only act during the racing phase.
  if (state.phase !== 'GAME_ROUND') {
    console.log(`[STATE PARSER] Phase=${state.phase} — waiting for GAME_ROUND`);
    return null;
  }

  // canPlayerMove handles both TURNS (currentTurnIndex check) and TIMED mode.
  if (!canPlayerMove(state, myConnectionId)) {
    return null;
  }

  const myPlayer = state.players.find((p) => p.connectionId === myConnectionId);
  if (!myPlayer) {
    console.warn('[STATE PARSER] Own Player record not found in state');
    return null;
  }

  // Finished players must not submit further moves.
  if (myPlayer.finishOrder !== undefined) {
    console.log(`[STATE PARSER] Bot has already finished (position ${myPlayer.finishOrder})`);
    return null;
  }

  const track: TrackDefinition | undefined = getTrackById(state.trackId);
  if (!track) {
    console.warn(`[STATE PARSER] Unknown trackId "${state.trackId}"`);
    return null;
  }

  const otherPlayers: Player[] = state.players.filter(
    (p) => p.connectionId !== myConnectionId
  );

  return { myPlayer, gameState: state, track, otherPlayers };
}
