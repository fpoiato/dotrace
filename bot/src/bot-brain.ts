import {
  MAX_GEAR_DELTA,
  TrackDefinition,
  Vector2D,
  getTileAt,
  isValidGearChange,
  landingPosition,
} from '../../shared/ws-types';
import type { CarState, TrackState } from './state-parser';

export interface Acceleration {
  dx: number;
  dy: number;
}

interface CandidateMove {
  dx: number;
  dy: number;
  nextVelocity: Vector2D;
  landing: Vector2D;
}

/**
 * Pathfinding stub — enumerates the 9 legal gear changes and picks a
 * placeholder move. Replace the scoring logic with a real planner later.
 */
export class BotBrain {
  /** Cached finish-line centroid for greedy distance heuristic. */
  private finishGoal: Vector2D | null = null;

  /**
   * Compute the acceleration (Δv per axis) for the next turn.
   * Returns `{ dx, dy }` where each component is in {-1, 0, 1}.
   */
  computeNextMove(carState: CarState, trackState: TrackState, track: TrackDefinition): Acceleration {
    const candidates = this.enumerateCandidates(carState, trackState, track);
    if (candidates.length === 0) {
      return { dx: 0, dy: 0 };
    }

    const goal = this.getFinishGoal(track);
    const best = this.pickGreedy(candidates, goal);
    return { dx: best.dx, dy: best.dy };
  }

  /** All 9 gear-change options, filtered to in-bounds landings. */
  private enumerateCandidates(
    carState: CarState,
    trackState: TrackState,
    track: TrackDefinition
  ): CandidateMove[] {
    const { position, velocity, isOffTrack } = carState;
    const candidates: CandidateMove[] = [];

    for (let dx = -MAX_GEAR_DELTA; dx <= MAX_GEAR_DELTA; dx++) {
      for (let dy = -MAX_GEAR_DELTA; dy <= MAX_GEAR_DELTA; dy++) {
        const nextVelocity: Vector2D = { x: velocity.x + dx, y: velocity.y + dy };

        if (!isValidGearChange(velocity, nextVelocity, isOffTrack)) continue;

        const landing = landingPosition(position, nextVelocity);
        if (!this.isInBounds(landing, trackState)) continue;
        const tile = getTileAt(track, landing.x, landing.y);
        if (tile === null || tile === 'pit' || tile === 'pitbox') continue;

        candidates.push({ dx, dy, nextVelocity, landing });
      }
    }

    return candidates;
  }

  private isInBounds(point: Vector2D, trackState: TrackState): boolean {
    return (
      point.x >= 0 &&
      point.x < trackState.width &&
      point.y >= 0 &&
      point.y < trackState.height
    );
  }

  /** Placeholder: minimize Manhattan distance to the finish stripe centroid. */
  private pickGreedy(candidates: CandidateMove[], goal: Vector2D): CandidateMove {
    let best = candidates[0];
    let bestScore = Number.POSITIVE_INFINITY;

    for (const move of candidates) {
      const score =
        Math.abs(move.landing.x - goal.x) + Math.abs(move.landing.y - goal.y);
      if (score < bestScore) {
        bestScore = score;
        best = move;
      }
    }

    return best;
  }

  private getFinishGoal(track: TrackDefinition): Vector2D {
    if (this.finishGoal) return this.finishGoal;

    let sumX = 0;
    let sumY = 0;
    let count = 0;

    for (let y = 0; y < track.height; y++) {
      for (let x = 0; x < track.width; x++) {
        if (track.grid[y][x] === 'finish') {
          sumX += x;
          sumY += y;
          count++;
        }
      }
    }

    this.finishGoal =
      count > 0
        ? { x: Math.round(sumX / count), y: Math.round(sumY / count) }
        : { x: Math.floor(track.width / 2), y: Math.floor(track.height / 2) };

    return this.finishGoal;
  }
}
