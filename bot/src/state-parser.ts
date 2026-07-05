import type { GameState, Player, TrackDefinition, Vector2D, WsEnvelope } from '../../shared/ws-types';
import { activeRacers, canPlayerMove } from '../../shared/ws-types';
import { getTrackById } from '../../shared/tracks';

/**
 * A bot-centric, strongly-typed snapshot derived from the host-authoritative
 * `GameState`. Everything the brain needs to think, and nothing it does not.
 */
export interface BotView {
  /** Full authoritative state (kept for reference / debugging). */
  state: GameState;
  /** Resolved track definition (grid, finish tiles, checkpoint). */
  track: TrackDefinition;
  /** The bot's own car. */
  car: Player;
  /** Other racers still on track — obstacles to avoid. */
  opponents: Player[];
  /** True when the rules allow the bot to submit a move right now. */
  isMyTurn: boolean;
}

/** A Vector2D that survived structural validation. */
function isVector(v: unknown): v is Vector2D {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as Vector2D).x === 'number' &&
    typeof (v as Vector2D).y === 'number'
  );
}

/**
 * Defensive parse of an inbound RELAY envelope into a `GameState`.
 * We never trust the wire blindly: a malformed payload returns `null`
 * so the orchestrator can ignore it instead of crashing mid-race.
 */
export function parseRelayState(envelope: WsEnvelope): GameState | null {
  if (envelope.action !== 'RELAY') return null;
  const payload = envelope.payload as { type?: string; state?: unknown } | null;
  const state = payload?.state as GameState | undefined;
  if (!state || !Array.isArray(state.players) || typeof state.phase !== 'string') {
    return null;
  }
  // Older hosts may omit gameMode; default to classic turn order.
  if (!state.gameMode) state.gameMode = 'TURNS';
  return state;
}

/**
 * Project the authoritative state onto the bot. Returns `null` when the bot
 * cannot act (not in the race, race not running, missing track, etc.).
 */
export function buildBotView(state: GameState, botId: string): BotView | null {
  const car = state.players.find((p) => p.connectionId === botId);
  if (!car) return null;

  const track = getTrackById(state.trackId);
  if (!track) return null;

  // Guard against a partially-initialized car (pre-grid placement).
  if (!isVector(car.position) || !isVector(car.velocity)) return null;

  return {
    state,
    track,
    car,
    opponents: activeRacers(state.players, botId),
    isMyTurn: canPlayerMove(state, botId),
  };
}
