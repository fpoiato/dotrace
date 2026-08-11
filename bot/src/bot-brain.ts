import { BotMemory, chooseBotMove, createBotMemory } from '../../shared/bot-ai';
import { Player, TrackDefinition, Vector2D, createLobbyPlayer } from '../../shared/ws-types';
import type { CarState, TrackState } from './state-parser';

export interface Acceleration {
  dx: number;
  dy: number;
}

/** Cars further than this from the last known spot mean a new race started. */
const TELEPORT_THRESHOLD = 12;

/**
 * Adapter between the headless client and the shared racing AI
 * (shared/bot-ai.ts): keeps per-race line-progress memory and converts the
 * chosen velocity back into an acceleration delta for the move envelope.
 */
export class BotBrain {
  private memory: BotMemory | null = null;
  private memoryTrackId: string | null = null;
  private lastPosition: Vector2D | null = null;

  /**
   * Compute the acceleration (Δv per axis) for the next turn.
   * Returns `{ dx, dy }` where each component is in {-1, 0, 1}.
   */
  computeNextMove(
    carState: CarState,
    trackState: TrackState,
    track: TrackDefinition,
    others: Player[] = [],
    round = 1
  ): Acceleration {
    // A teleport (back to the start grid) means a new race: re-anchor.
    const teleported =
      this.lastPosition !== null &&
      Math.hypot(
        carState.position.x - this.lastPosition.x,
        carState.position.y - this.lastPosition.y
      ) > TELEPORT_THRESHOLD;
    if (!this.memory || this.memoryTrackId !== track.id || teleported) {
      this.memory = createBotMemory();
      this.memoryTrackId = track.id;
    }
    this.lastPosition = { ...carState.position };

    // Rebuild a Player-shaped view so the shared rules (getValidMoves) apply
    // exactly as the host sees them. state-parser reports the gear-limited
    // flag; map it back onto the fields isGearLimited inspects.
    const gearLimited = carState.gearLimited ?? carState.isOffTrack;
    const pseudoPlayer: Player = {
      ...createLobbyPlayer('bot-self', 'Bot', false, 0, '#000000'),
      position: { ...carState.position },
      velocity: { ...carState.velocity },
      isOffTrack: carState.isOffTrack,
      gearPenaltyUntilRound:
        gearLimited && !carState.isOffTrack ? round + 1 : undefined,
    };

    const velocity = chooseBotMove(pseudoPlayer, track, others, round, this.memory);
    return {
      dx: clampDelta(velocity.x - carState.velocity.x),
      dy: clampDelta(velocity.y - carState.velocity.y),
    };
  }
}

function clampDelta(d: number): number {
  return Math.max(-1, Math.min(1, d));
}
