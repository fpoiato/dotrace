/**
 * botBrain.ts — Racing pathfinder for the Dot Race bot.
 *
 * ─── Vector Rally physics recap ──────────────────────────────────────────────
 *
 *   Each turn the driver submits a new VELOCITY vector (not a delta).
 *   The new velocity must satisfy the ±1 gear-change rule on both axes:
 *     |newVel.x − oldVel.x| ≤ 1  AND  |newVel.y − oldVel.y| ≤ 1
 *
 *   Landing on a grass tile kills all momentum (vel → {0,0}) and marks the
 *   car as off-track, restricting next-turn velocities to {-1,0,1} per axis.
 *
 *   A lap only completes when the car crosses the finish stripe *after* having
 *   first entered the checkpoint zone (the far side of the circuit).  This
 *   prevents short-cutting back over the line on lap 1.
 *
 * ─── BFS strategy ────────────────────────────────────────────────────────────
 *
 *   State: (x, y, vx, vy, passedCheckpoint) — a 5-tuple.
 *
 *   The BFS expands states turn-by-turn in breadth-first order.  Because BFS
 *   visits shallowest nodes first, the first time it reaches the finish stripe
 *   it has found the *fewest-turn* route.  We backtrack to the first move
 *   taken from the initial position and return that velocity.
 *
 *   For the first move only, the game-engine's own `getValidMoves` is used so
 *   collision avoidance with other racers is respected.  Subsequent moves
 *   in the BFS ignore opponent positions (they will have moved by then).
 *
 *   If BFS exhausts `MAX_VISITED` states without finding the finish, a greedy
 *   Euclidean-distance-to-finish-centroid heuristic is used as a fallback.
 *
 * ─── Complexity ──────────────────────────────────────────────────────────────
 *
 *   Worst-case state space on the 56×36 grid with |vel| ≤ 6:
 *     56 × 36 × 13 × 13 × 2 ≈ 680 k states
 *   In practice most positions are grass (unreachable), so visited counts stay
 *   well below the 300 k hard cap, and each turn computes in < 200 ms.
 */

import type { Player, TrackDefinition, Vector2D } from '../../shared/ws-types';
import {
  MAX_GEAR_DELTA,
  getValidMoves,
  getTileAt,
  isValidGearChange,
  landingPosition,
  segmentCrossesFinish,
  segmentEntersRect,
} from '../../shared/ws-types';

// ─── BFS types ────────────────────────────────────────────────────────────────

/** 5-tuple uniquely identifying a car's physics state for the search. */
interface BfsState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Whether the far-side checkpoint has been crossed this lap. */
  passedCheckpoint: boolean;
}

interface QueueEntry {
  state: BfsState;
  /** The velocity chosen at move #1 that started this path. */
  firstMove: Vector2D;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Stop BFS after visiting this many states to bound worst-case runtime. */
const MAX_VISITED = 300_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Compact string key for the visited set — avoids object allocation per state. */
function stateKey({ x, y, vx, vy, passedCheckpoint }: BfsState): string {
  // Velocity components are signed; bias by 10 to keep keys short and positive.
  return `${x},${y},${vx + 10},${vy + 10},${passedCheckpoint ? 1 : 0}`;
}

/**
 * Expand one BFS state into successor states by applying all 9 gear-change
 * combinations (dvx, dvy) ∈ {−1, 0, +1}².  Returns only moves that land
 * on a non-null grid tile (walls and out-of-bounds are excluded).
 */
function successors(
  state: BfsState,
  track: TrackDefinition
): Array<{ next: BfsState; crossedFinish: boolean }> {
  const pos: Vector2D = { x: state.x, y: state.y };
  const vel: Vector2D = { x: state.vx, y: state.vy };
  // A car sitting on grass is off-track; its choices are restricted.
  const isOffTrack = getTileAt(track, state.x, state.y) === 'grass';
  const result: Array<{ next: BfsState; crossedFinish: boolean }> = [];

  for (let dvx = -MAX_GEAR_DELTA; dvx <= MAX_GEAR_DELTA; dvx++) {
    for (let dvy = -MAX_GEAR_DELTA; dvy <= MAX_GEAR_DELTA; dvy++) {
      const nextVel: Vector2D = { x: vel.x + dvx, y: vel.y + dvy };

      // Enforce ±1 gear rule and off-track speed cap via shared validation.
      if (!isValidGearChange(vel, nextVel, isOffTrack)) continue;

      const landing = landingPosition(pos, nextVel);
      const tile = getTileAt(track, landing.x, landing.y);
      // null → outside the grid boundary — not a legal landing.
      if (tile === null) continue;

      // Grass kills momentum; the car becomes off-track with zero velocity.
      const landOnGrass = tile === 'grass';
      const actualVel: Vector2D = landOnGrass ? { x: 0, y: 0 } : nextVel;

      // Check whether the move enters the far-side checkpoint.
      let nextPassedCheckpoint = state.passedCheckpoint;
      if (!nextPassedCheckpoint && track.checkpoint) {
        nextPassedCheckpoint = segmentEntersRect(pos, landing, track.checkpoint);
      }

      // A lap finishes when the segment crosses the finish stripe *and* the
      // checkpoint has been (or is now being) passed, and the car lands on track.
      const crossedFinish =
        nextPassedCheckpoint &&
        !landOnGrass &&
        segmentCrossesFinish(track, pos, landing);

      result.push({
        next: {
          x: landing.x,
          y: landing.y,
          vx: actualVel.x,
          vy: actualVel.y,
          passedCheckpoint: nextPassedCheckpoint,
        },
        crossedFinish,
      });
    }
  }
  return result;
}

// ─── BFS core ─────────────────────────────────────────────────────────────────

/**
 * Run a BFS over the (position × velocity × checkpoint) state space to find
 * the move that leads to the finish line in the fewest turns.
 *
 * Returns the velocity to submit this turn, or `null` if no path was found
 * within the visited-state budget (caller falls back to the greedy heuristic).
 */
function bfsSearch(player: Player, track: TrackDefinition, others: Player[]): Vector2D | null {
  const origin: BfsState = {
    x: player.position.x,
    y: player.position.y,
    vx: player.velocity.x,
    vy: player.velocity.y,
    // `passedCheckpoint` is false when the player is placed on the grid; it
    // becomes true once they enter the far-side zone.  If a track has no
    // checkpoint the flag stays true-ish (no constraint).
    passedCheckpoint: track.checkpoint ? (player.passedCheckpoint ?? false) : true,
  };

  const visited = new Set<string>([stateKey(origin)]);
  const queue: QueueEntry[] = [];

  // ── Seed: legal first moves (includes collision avoidance with opponents) ──
  const firstMoves = getValidMoves(player, track, others);

  for (const { velocity, landing } of firstMoves) {
    const tile = getTileAt(track, landing.x, landing.y);
    if (tile === null) continue;

    const landOnGrass = tile === 'grass';
    const actualVel: Vector2D = landOnGrass ? { x: 0, y: 0 } : velocity;

    let passedCheckpoint = origin.passedCheckpoint;
    if (!passedCheckpoint && track.checkpoint) {
      passedCheckpoint = segmentEntersRect(player.position, landing, track.checkpoint);
    }

    // If the very first move already crosses the finish — take it immediately.
    if (passedCheckpoint && !landOnGrass && segmentCrossesFinish(track, player.position, landing)) {
      console.log('[BOT BRAIN] Finish reachable in 1 move — taking it');
      return velocity;
    }

    const next: BfsState = {
      x: landing.x,
      y: landing.y,
      vx: actualVel.x,
      vy: actualVel.y,
      passedCheckpoint,
    };
    const key = stateKey(next);
    if (!visited.has(key)) {
      visited.add(key);
      queue.push({ state: next, firstMove: velocity });
    }
  }

  // ── BFS expansion ──────────────────────────────────────────────────────────
  let i = 0;
  while (i < queue.length && visited.size < MAX_VISITED) {
    const { state, firstMove } = queue[i++]!;

    for (const { next, crossedFinish } of successors(state, track)) {
      // Found the finish — return the first move that led here.
      if (crossedFinish) {
        console.log(`[BOT BRAIN] BFS found finish path (visited=${visited.size})`);
        return firstMove;
      }

      const key = stateKey(next);
      if (!visited.has(key)) {
        visited.add(key);
        queue.push({ state: next, firstMove });
      }
    }
  }

  console.log(`[BOT BRAIN] BFS exhausted ${visited.size} states without reaching finish`);
  return null;
}

// ─── Greedy fallback ──────────────────────────────────────────────────────────

/**
 * Greedy heuristic: among legal first moves, pick the one whose landing
 * position is closest to the centroid of all finish tiles.  Grass landings
 * are penalised heavily to bias toward staying on track.
 */
function greedyMove(
  player: Player,
  track: TrackDefinition,
  others: Player[]
): Vector2D {
  const legalMoves = getValidMoves(player, track, others);

  if (legalMoves.length === 0) {
    // Emergency stop — should only occur if getValidMoves itself returns [].
    return { x: 0, y: 0 };
  }

  // Collect finish-tile centroids for distance scoring.
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let y = 0; y < track.height; y++) {
    for (let x = 0; x < track.width; x++) {
      if (track.grid[y]![x] === 'finish') {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }

  if (count === 0) {
    // No finish tiles found — just return the first legal move.
    return legalMoves[0]!.velocity;
  }

  const cx = sumX / count;
  const cy = sumY / count;

  let best = legalMoves[0]!;
  let bestScore = Infinity;

  for (const move of legalMoves) {
    const tile = getTileAt(track, move.landing.x, move.landing.y);
    // Heavy penalty for landing on grass — avoid it unless no other option.
    const grassPenalty = tile === 'grass' ? 1_000 : 0;
    const dist = Math.hypot(move.landing.x - cx, move.landing.y - cy) + grassPenalty;
    if (dist < bestScore) {
      bestScore = dist;
      best = move;
    }
  }

  return best.velocity;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export class BotBrain {
  /**
   * Decide the next velocity vector to submit.
   *
   * The returned object is sent verbatim as the `vector` field in a
   * `SUBMIT_MOVE` player action.  It represents the *new velocity*, not an
   * acceleration delta — the host validates it against the ±1 gear-change rule.
   *
   * @param player  The bot's own Player record from the authoritative state.
   * @param track   Resolved TrackDefinition (grid, finish stripe, checkpoint).
   * @param others  Other active racers for collision avoidance on move 1.
   */
  computeNextMove(player: Player, track: TrackDefinition, others: Player[]): Vector2D {
    console.log(
      `[BOT BRAIN] pos=(${player.position.x},${player.position.y})` +
        ` vel=(${player.velocity.x},${player.velocity.y})` +
        ` offTrack=${player.isOffTrack}` +
        ` checkpoint=${player.passedCheckpoint ?? false}`
    );

    // Try BFS first; fall back to greedy if the search budget is exhausted.
    const velocity =
      bfsSearch(player, track, others) ??
      (console.log('[BOT BRAIN] Falling back to greedy heuristic'),
        greedyMove(player, track, others));

    const landing = landingPosition(player.position, velocity);
    console.log(
      `[BOT BRAIN] → vel=(${velocity.x},${velocity.y}) landing=(${landing.x},${landing.y})`
    );

    return velocity;
  }
}
