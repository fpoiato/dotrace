/**
 * The Brain — pathfinder stub.
 *
 * Vector Rally kinematics: each turn the car picks an acceleration
 * a = (dx, dy) with dx,dy ∈ {-1, 0, 1}. The new velocity is v' = v + a and
 * the car lands at p' = p + v'. computeNextMove enumerates all 9 candidate
 * accelerations, filters the illegal ones, and greedily scores the rest
 * against a goal coordinate. Swap the scoring for A-star / BFS later
 * without touching the socket or state layers.
 */
import {
  CheckpointRect,
  Player,
  TrackDefinition,
  Vector2D,
  activeRacers,
  getTileAt,
  gearOf,
  isValidGearChange,
  landingPosition,
} from '../../shared/ws-types';
import { log } from './log';

export interface BrainMove {
  /** Chosen grid acceleration, each component in {-1, 0, 1}. */
  acceleration: { dx: number; dy: number };
  /** Resulting absolute velocity v' = v + a — what SUBMIT_MOVE expects. */
  velocity: Vector2D;
  /** Where the car will land: p' = p + v'. */
  landing: Vector2D;
}

interface Candidate extends BrainMove {
  tile: ReturnType<typeof getTileAt>;
}

function rectCenter(rect: CheckpointRect): Vector2D {
  return { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 };
}

/** Nearest finish-stripe tile to the car — the end-goal once the checkpoint is done. */
function nearestFinishTile(track: TrackDefinition, from: Vector2D): Vector2D | null {
  let best: Vector2D | null = null;
  let bestDist = Infinity;
  for (let y = 0; y < track.height; y++) {
    for (let x = 0; x < track.width; x++) {
      if (track.grid[y][x] !== 'finish') continue;
      const d = Math.hypot(x - from.x, y - from.y);
      if (d < bestDist) {
        bestDist = d;
        best = { x, y };
      }
    }
  }
  return best;
}

export class BotBrain {
  /**
   * Compute the next move for the given car and track state.
   * Returns the chosen acceleration `{ dx, dy }` plus the derived velocity
   * and landing point. Always returns something: worst case an emergency
   * stop (velocity 0,0) so the bot never stalls the game.
   */
  computeNextMove(carState: Player, trackState: TrackDefinition, others: Player[] = []): BrainMove {
    const { position, velocity, isOffTrack } = carState;
    const opponents = activeRacers(others, carState.connectionId);
    const candidates: Candidate[] = [];

    // Enumerate all 9 legal grid accelerations: dx ∈ {-1,0,1}, dy ∈ {-1,0,1}.
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const next: Vector2D = { x: velocity.x + dx, y: velocity.y + dy };

        // Filter 1: gear rules — max speed cap, off-track speed limit.
        if (!isValidGearChange(velocity, next, isOffTrack)) continue;

        const landing = landingPosition(position, next);
        const tile = getTileAt(trackState, landing.x, landing.y);

        // Filter 2: obviously out of bounds — landing outside the grid.
        if (tile === null) continue;

        // Filter 3: never land on top of another live car.
        if (opponents.some((o) => o.position.x === landing.x && o.position.y === landing.y)) {
          continue;
        }

        candidates.push({ acceleration: { dx, dy }, velocity: next, landing, tile });
      }
    }

    if (candidates.length === 0) {
      // No legal option: mirror the host's emergency-stop rule (stay put, gear 0).
      log('BRAIN', 'No legal moves — emergency stop');
      return { acceleration: { dx: -velocity.x, dy: -velocity.y }, velocity: { x: 0, y: 0 }, landing: { ...position } };
    }

    // Goal selection: head for the far-side checkpoint first (a lap only
    // counts after passing it), then chase the nearest finish tile.
    const goal =
      trackState.checkpoint && !carState.passedCheckpoint
        ? rectCenter(trackState.checkpoint)
        : nearestFinishTile(trackState, position) ?? { x: trackState.width / 2, y: trackState.height / 2 };

    const best = candidates.reduce((a, b) => (this.score(b, goal) < this.score(a, goal) ? b : a));

    log(
      'BRAIN',
      `pos=(${position.x},${position.y}) v=(${velocity.x},${velocity.y}) → a=(${best.acceleration.dx},${best.acceleration.dy}) ` +
        `v'=(${best.velocity.x},${best.velocity.y}) land=(${best.landing.x},${best.landing.y}) tile=${best.tile} ` +
        `goal=(${goal.x.toFixed(1)},${goal.y.toFixed(1)}) candidates=${candidates.length}`
    );
    return { acceleration: best.acceleration, velocity: best.velocity, landing: best.landing };
  }

  /** Lower is better: greedy distance-to-goal with penalties for grass and crawling. */
  private score(move: Candidate, goal: Vector2D): number {
    const dist = Math.hypot(goal.x - move.landing.x, goal.y - move.landing.y);
    const grassPenalty = move.tile === 'grass' ? 25 : 0; // landing on grass kills all momentum
    const slowPenalty = gearOf(move.velocity) === 0 ? 5 : 0; // standing still rarely helps
    return dist + grassPenalty + slowPenalty;
  }
}
