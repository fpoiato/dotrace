/**
 * Host-side computer opponent for Dot Race.
 * Picks among legal moves from getValidMoves using a greedy heuristic that
 * races toward the checkpoint / finish and avoids grass traps.
 */
import {
  Player,
  TrackDefinition,
  Vector2D,
  getTileAt,
  getValidMoves,
  isGrassShortcut,
  landingPosition,
  segmentCrossesFinish,
  segmentEntersRect,
  zeroVector,
} from './ws-types';

/** Delay before the host applies a bot move so humans can see turn flow. */
export const BOT_MOVE_DELAY_MS = 700;

/** Extra stagger between simultaneous TIMED-mode bot moves. */
export const BOT_TIMED_STAGGER_MS = 180;

function finishCentroid(track: TrackDefinition): Vector2D {
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
  if (count === 0) {
    return { x: Math.floor(track.width / 2), y: Math.floor(track.height / 2) };
  }
  return { x: sumX / count, y: sumY / count };
}

function checkpointCentroid(track: TrackDefinition): Vector2D | null {
  const cp = track.checkpoint;
  if (!cp) return null;
  return { x: (cp.x0 + cp.x1) / 2, y: (cp.y0 + cp.y1) / 2 };
}

function manhattan(a: Vector2D, b: Vector2D): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function scoreMove(
  player: Player,
  track: TrackDefinition,
  velocity: Vector2D,
  landing: Vector2D
): number {
  const from = player.position;
  const tile = getTileAt(track, landing.x, landing.y);
  const goal =
    player.passedCheckpoint || !track.checkpoint
      ? finishCentroid(track)
      : checkpointCentroid(track) ?? finishCentroid(track);

  // Lower distance is better — invert into a score.
  let score = -manhattan(landing, goal) * 10;

  // Prefer staying on asphalt / finish.
  if (tile === 'grass' || tile === 'rumble') {
    score -= 400;
  } else if (tile === 'track' || tile === 'finish') {
    score += 15;
  }

  if (isGrassShortcut(track, from, landing)) {
    score -= 250;
  }

  if (track.checkpoint && !player.passedCheckpoint) {
    if (segmentEntersRect(from, landing, track.checkpoint)) {
      score += 120;
    }
  }

  const crossedFinish =
    player.passedCheckpoint !== false && segmentCrossesFinish(track, from, landing);
  if (crossedFinish && tile !== 'grass' && tile !== 'rumble') {
    score += 500;
  }

  // Mild preference for carrying useful speed without redlining into traps.
  const gear = Math.max(Math.abs(velocity.x), Math.abs(velocity.y));
  if (tile === 'track' || tile === 'finish') {
    score += Math.min(gear, 4) * 3;
  }

  // Tiny nudge so ties are stable (prefer smaller |dv| already enumerated order).
  score -= gear * 0.01;

  return score;
}

/**
 * Choose the absolute next velocity for a computer opponent.
 * Always returns a vector that is legal per getValidMoves (or {0,0}).
 */
export function pickBotMove(
  player: Player,
  track: TrackDefinition,
  others: Player[],
  round: number
): Vector2D {
  const moves = getValidMoves(player, track, others, round);
  if (moves.length === 0) return zeroVector();

  let best = moves[0];
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const move of moves) {
    const score = scoreMove(player, track, move.velocity, move.landing);
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }

  // Sanity: landing must match physics (guards against future getValidMoves drift).
  const expected = landingPosition(player.position, best.velocity);
  if (expected.x !== best.landing.x || expected.y !== best.landing.y) {
    return best.velocity;
  }
  return { ...best.velocity };
}
