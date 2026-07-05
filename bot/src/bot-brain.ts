import type { Player, TileType, TrackDefinition, Vector2D } from '../../shared/ws-types';
import {
  MAX_GEAR,
  MAX_GEAR_DELTA,
  OFF_TRACK_GEARS,
  findCollisionOpponent,
  gearOf,
  getTileAt,
  landingPosition,
} from '../../shared/ws-types';
import type { Logger } from './logger.js';

/** Acceleration applied to the car's velocity this turn. dx, dy ∈ {-1, 0, 1}. */
export interface Acceleration {
  dx: number;
  dy: number;
}

/** Just the slice of the car the brain reasons about. */
export interface CarState {
  position: Vector2D;
  velocity: Vector2D;
  isOffTrack: boolean;
  passedCheckpoint: boolean;
  lap: number;
}

/** Track plus dynamic obstacles for this decision. */
export interface TrackState {
  track: TrackDefinition;
  opponents: Player[];
}

/** A fully-evaluated candidate move (one of the ≤9 legal options). */
interface Candidate {
  acceleration: Acceleration;
  /** Resulting velocity vector = current velocity + acceleration. */
  velocity: Vector2D;
  /** Where the car lands = current position + resulting velocity. */
  landing: Vector2D;
  tile: TileType;
  /** Lower is better. */
  score: number;
}

/** The 9 legal grid accelerations: every (dx, dy) with dx, dy ∈ {-1, 0, 1}. */
const ACCELERATIONS: Acceleration[] = (() => {
  const out: Acceleration[] = [];
  for (let dx = -MAX_GEAR_DELTA; dx <= MAX_GEAR_DELTA; dx++) {
    for (let dy = -MAX_GEAR_DELTA; dy <= MAX_GEAR_DELTA; dy++) {
      out.push({ dx, dy });
    }
  }
  return out;
})();

/**
 * The bot's decision engine (pathfinder stub).
 *
 * Vector-rally physics recap: each turn the car may nudge its velocity by at
 * most ±1 per axis. The next position is `position + velocity`. So the whole
 * problem is choosing one of nine accelerations, then living with the momentum.
 *
 * This stub implements a greedy, momentum-aware distance heuristic toward a
 * goal (the far-side checkpoint until it is cleared, then the finish stripe).
 * It is intentionally simple — swap the scoring for A-star or beam search
 * later without touching the transport or parsing layers.
 */
export class BotBrain {
  /** Cache of goal geometry per track id (finish centroid + tiles). */
  private readonly goalCache = new Map<string, { finish: Vector2D; finishTiles: Vector2D[] }>();

  constructor(private readonly log?: Logger) {}

  /**
   * Compute the chosen acceleration for this turn.
   *
   * @returns `{ dx, dy }` with dx, dy ∈ {-1, 0, 1}.
   */
  computeNextMove(carState: CarState, trackState: TrackState): Acceleration {
    const candidates = this.evaluateCandidates(carState, trackState);

    if (candidates.length === 0) {
      // Every acceleration flies off the grid. Bleed off momentum toward a
      // stop (always within the ±1 rule); the host also offers a full stop as
      // its own emergency fallback if this still can't land.
      const fallback: Acceleration = {
        dx: -Math.sign(carState.velocity.x),
        dy: -Math.sign(carState.velocity.y),
      };
      this.log?.debug('[BRAIN] no legal move — decelerating', fallback);
      return fallback;
    }

    // Candidates are pre-sorted best-first (lowest score).
    const best = candidates[0];
    this.log?.debug(
      '[BRAIN]',
      `accel=(${best.acceleration.dx},${best.acceleration.dy})`,
      `vel=(${best.velocity.x},${best.velocity.y})`,
      `land=(${best.landing.x},${best.landing.y})`,
      `tile=${best.tile}`,
      `score=${best.score.toFixed(2)}`
    );
    return best.acceleration;
  }

  /**
   * Enumerate the 9 accelerations, discard illegal / out-of-bounds ones, and
   * score the survivors. Exposed for tests and richer logging.
   */
  evaluateCandidates(carState: CarState, trackState: TrackState): Candidate[] {
    const { position, velocity, isOffTrack } = carState;
    const { track, opponents } = trackState;
    const goal = this.goalFor(carState, track);

    const candidates: Candidate[] = [];

    for (const acc of ACCELERATIONS) {
      const nextVelocity: Vector2D = { x: velocity.x + acc.dx, y: velocity.y + acc.dy };

      // --- Rule filters (identical to the host's move validation) ---

      // Top-speed cap: Chebyshev magnitude of velocity can never exceed MAX_GEAR.
      if (gearOf(nextVelocity) > MAX_GEAR) continue;

      // Off the track, only slow "crawl" gears (-1..1) are allowed per axis.
      if (isOffTrack) {
        if (!OFF_TRACK_GEARS.includes(nextVelocity.x as (typeof OFF_TRACK_GEARS)[number])) continue;
        if (!OFF_TRACK_GEARS.includes(nextVelocity.y as (typeof OFF_TRACK_GEARS)[number])) continue;
      }

      const landing = landingPosition(position, nextVelocity);

      // Must stay on the grid.
      const tile = getTileAt(track, landing.x, landing.y);
      if (tile === null) continue;

      // Never share a square with an active opponent.
      if (opponents.some((o) => o.position.x === landing.x && o.position.y === landing.y)) continue;

      candidates.push({
        acceleration: acc,
        velocity: nextVelocity,
        landing,
        tile,
        score: this.score(carState, trackState, nextVelocity, landing, tile, goal),
      });
    }

    candidates.sort((a, b) => a.score - b.score);
    return candidates;
  }

  /**
   * Lower is better. Combines: distance-to-goal (primary), a big penalty for
   * landing on grass (which kills all momentum), a penalty for a crash path
   * through an opponent, and a mild bonus for carrying speed toward the goal.
   */
  private score(
    carState: CarState,
    trackState: TrackState,
    velocity: Vector2D,
    landing: Vector2D,
    tile: TileType,
    goal: Vector2D
  ): number {
    let s = distance(landing, goal);

    // Landing on grass = gravel trap: stop dead and lose all speed. Avoid hard.
    if (tile === 'grass') s += 1000;

    // Flying through another car counts as a crash (stop). Strongly discouraged.
    const crash = findCollisionOpponent(
      '__bot__',
      carState.position,
      landing,
      trackState.opponents.map((o) => ({ ...o, connectionId: o.connectionId || 'op' }))
    );
    if (crash) s += 500;

    // Prefer momentum that points at the goal (rewards committing to a line
    // rather than dithering at gear 0). Subtracts up to ~a few units.
    const toGoal = { x: goal.x - carState.position.x, y: goal.y - carState.position.y };
    const mag = Math.hypot(toGoal.x, toGoal.y) || 1;
    const advance = (velocity.x * toGoal.x + velocity.y * toGoal.y) / mag;
    s -= advance * 0.5;

    return s;
  }

  /**
   * Current navigation target:
   *  - if the far-side checkpoint has not been cleared yet, aim at its centre
   *    (this routes the car the "long way" around, preventing a turn-one
   *    reverse over the finish line);
   *  - otherwise aim at the finish stripe.
   */
  private goalFor(carState: CarState, track: TrackDefinition): Vector2D {
    if (track.checkpoint && !carState.passedCheckpoint) {
      const cp = track.checkpoint;
      return { x: (cp.x0 + cp.x1) / 2, y: (cp.y0 + cp.y1) / 2 };
    }
    return this.finishGoal(track).finish;
  }

  private finishGoal(track: TrackDefinition): { finish: Vector2D; finishTiles: Vector2D[] } {
    const cached = this.goalCache.get(track.id);
    if (cached) return cached;

    const finishTiles: Vector2D[] = [];
    for (let y = 0; y < track.height; y++) {
      for (let x = 0; x < track.width; x++) {
        if (track.grid[y][x] === 'finish') finishTiles.push({ x, y });
      }
    }
    const finish =
      finishTiles.length > 0
        ? {
            x: finishTiles.reduce((a, t) => a + t.x, 0) / finishTiles.length,
            y: finishTiles.reduce((a, t) => a + t.y, 0) / finishTiles.length,
          }
        : { x: track.width / 2, y: track.height / 2 };

    const entry = { finish, finishTiles };
    this.goalCache.set(track.id, entry);
    return entry;
  }
}

function distance(a: Vector2D, b: Vector2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
