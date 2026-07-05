/**
 * BotBrain — the pathfinding module.
 *
 * Pure math, no I/O: given the bot's car state and the track, pick the next
 * acceleration. Current implementation is a greedy pathfinder stub:
 *
 *   1. Enumerate all 9 candidate velocities (dx, dy ∈ {-1, 0, 1}).
 *   2. Filter out illegal / out-of-bounds options via the shared game rules.
 *   3. Score survivors against a BFS distance field toward the current goal
 *      (checkpoint zone first, finish stripe after) and pick the minimum.
 *
 * The BFS field is a placeholder for a proper A*-over-(pos, vel) search; the
 * interface (car + track in, {dx, dy} out) is stable for that upgrade.
 */
import {
  MAX_GEAR_DELTA,
  Player,
  TrackDefinition,
  Vector2D,
  getTileAt,
  getValidMoves,
  landingPosition,
  isValidGearChange,
} from '../../shared/ws-types';

export interface Acceleration {
  dx: number;
  dy: number;
}

interface ScoredMove {
  accel: Acceleration;
  velocity: Vector2D;
  landing: Vector2D;
  score: number;
}

const UNREACHABLE = Number.POSITIVE_INFINITY;

export class BotBrain {
  /** Distance fields keyed by `${trackId}:${goal}` — BFS is computed once per goal. */
  private readonly fieldCache = new Map<string, number[][]>();

  /**
   * Compute the next acceleration for the bot's car.
   *
   * @param carState    the bot's Player entry from the host game state
   *                    (position, velocity, isOffTrack, passedCheckpoint)
   * @param trackState  full track definition (grid, finish tiles, checkpoint)
   * @param opponents   other players, used to avoid landing on their cells
   * @returns the chosen acceleration `{ dx, dy }`
   */
  computeNextMove(
    carState: Player,
    trackState: TrackDefinition,
    opponents: Player[] = []
  ): Acceleration {
    const { position, velocity } = carState;
    const field = this.distanceField(trackState, carState.passedCheckpoint === true);

    const candidates: ScoredMove[] = [];

    // Step 1 — the 9 legal grid accelerations: dx ∈ {-1,0,1}, dy ∈ {-1,0,1}.
    for (let dx = -MAX_GEAR_DELTA; dx <= MAX_GEAR_DELTA; dx++) {
      for (let dy = -MAX_GEAR_DELTA; dy <= MAX_GEAR_DELTA; dy++) {
        // New velocity = old velocity + acceleration (vector drawing rule).
        const next: Vector2D = { x: velocity.x + dx, y: velocity.y + dy };

        // Step 2 — filter obviously invalid options: gear cap, off-track
        // speed limit, and landings outside the paper grid.
        if (!isValidGearChange(velocity, next, carState.isOffTrack)) continue;
        const landing = landingPosition(position, next);
        const tile = getTileAt(trackState, landing.x, landing.y);
        if (tile === null) continue;
        // Never land on an opponent's cell: the host treats that as a crash.
        if (opponents.some((o) => o.position.x === landing.x && o.position.y === landing.y)) {
          continue;
        }

        candidates.push({
          accel: { dx, dy },
          velocity: next,
          landing,
          score: this.scoreMove(next, landing, tile === 'grass', trackState, field),
        });
      }
    }

    if (candidates.length === 0) {
      // No survivor: fall back to the shared emergency-stop rule so the bot
      // sends exactly what the host will accept.
      const fallback = getValidMoves(carState, trackState, opponents)[0];
      return {
        dx: fallback.velocity.x - velocity.x,
        dy: fallback.velocity.y - velocity.y,
      };
    }

    // Step 3 — greedy pick: lowest score wins (distance + penalties).
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0].accel;
  }

  /** Convenience: absolute velocity the server expects (`SUBMIT_MOVE.vector`). */
  toVelocity(carState: Player, accel: Acceleration): Vector2D {
    return { x: carState.velocity.x + accel.dx, y: carState.velocity.y + accel.dy };
  }

  /**
   * Greedy cost of one candidate: BFS steps from the landing cell to the goal,
   * plus penalties that keep the bot alive at speed.
   */
  private scoreMove(
    nextVelocity: Vector2D,
    landing: Vector2D,
    landsOnGrass: boolean,
    track: TrackDefinition,
    field: number[][]
  ): number {
    let score = field[landing.y]?.[landing.x] ?? UNREACHABLE;
    if (score === UNREACHABLE) score = 10_000; // reachable grid but off the racing surface

    // Gravel trap costs a full stop next turn — strongly discourage it.
    if (landsOnGrass) score += 500;

    // One-step lookahead: from (landing, nextVelocity), can we still choose a
    // follow-up move that stays on the grid and off the grass? If not, this
    // speed will slam us into the scenery next turn.
    if (!this.hasSafeFollowUp(landing, nextVelocity, track)) score += 2_000;

    return score;
  }

  /** True if at least one next-turn velocity keeps the car on track cells. */
  private hasSafeFollowUp(from: Vector2D, velocity: Vector2D, track: TrackDefinition): boolean {
    for (let dx = -MAX_GEAR_DELTA; dx <= MAX_GEAR_DELTA; dx++) {
      for (let dy = -MAX_GEAR_DELTA; dy <= MAX_GEAR_DELTA; dy++) {
        const next: Vector2D = { x: velocity.x + dx, y: velocity.y + dy };
        if (!isValidGearChange(velocity, next, false)) continue;
        const landing = landingPosition(from, next);
        const tile = getTileAt(track, landing.x, landing.y);
        if (tile === 'track' || tile === 'finish') return true;
      }
    }
    return false;
  }

  /**
   * BFS over drivable cells (track + finish) from the goal outward, so each
   * cell holds its step-distance to the goal. Goal is the far-side checkpoint
   * until the car has passed it, then the finish stripe — matching the lap
   * validity gate enforced by the host.
   */
  private distanceField(track: TrackDefinition, passedCheckpoint: boolean): number[][] {
    const goal = passedCheckpoint || !track.checkpoint ? 'finish' : 'checkpoint';
    const cacheKey = `${track.id}:${goal}`;
    const cached = this.fieldCache.get(cacheKey);
    if (cached) return cached;

    const field: number[][] = Array.from({ length: track.height }, () =>
      Array.from({ length: track.width }, () => UNREACHABLE)
    );
    const queue: Vector2D[] = [];

    for (let y = 0; y < track.height; y++) {
      for (let x = 0; x < track.width; x++) {
        const tile = track.grid[y][x];
        const isGoal =
          goal === 'finish'
            ? tile === 'finish'
            : tile !== 'grass' &&
              !!track.checkpoint &&
              x >= track.checkpoint.x0 &&
              x <= track.checkpoint.x1 &&
              y >= track.checkpoint.y0 &&
              y <= track.checkpoint.y1;
        if (isGoal) {
          field[y][x] = 0;
          queue.push({ x, y });
        }
      }
    }

    // 8-connected flood fill: cars move diagonally, so distance is Chebyshev-ish.
    for (let head = 0; head < queue.length; head++) {
      const { x, y } = queue[head];
      const d = field[y][x];
      for (let ny = y - 1; ny <= y + 1; ny++) {
        for (let nx = x - 1; nx <= x + 1; nx++) {
          if (nx === x && ny === y) continue;
          if (nx < 0 || nx >= track.width || ny < 0 || ny >= track.height) continue;
          if (track.grid[ny][nx] === 'grass') continue;
          if (field[ny][nx] <= d + 1) continue;
          field[ny][nx] = d + 1;
          queue.push({ x: nx, y: ny });
        }
      }
    }

    this.fieldCache.set(cacheKey, field);
    return field;
  }
}
