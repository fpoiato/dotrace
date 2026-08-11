/**
 * Computer-driver AI for Dot Race (Vector Rally).
 * Mirror into frontend/dotrace-app/src/app/core/models/bot-ai.ts.
 *
 * Strategy: racing-line following with a crash-avoidance rollout.
 *
 * Each track ships an ordered, closed-loop centerline (race direction). The
 * AI resamples it into ~1-cell waypoints and scores every candidate move by
 * the forward progress its landing makes along the line — so straights are
 * taken flat out and the car naturally follows the circuit. Candidate moves
 * come from the same `getValidMoves` the host uses to validate human moves,
 * so the AI can never submit an illegal velocity. An existential rollout
 * ("is there ANY line that keeps me on track for the next N plies?") makes
 * the AI brake before corners instead of discovering the gravel trap
 * first-hand, and a BFS distance field drives off-track recovery.
 *
 * Deliberately NOT done (party game, not ACC): opponent-aware overtaking,
 * blocking, slipstreaming. Bots ignore traffic beyond the occupied-cell rule
 * already enforced by `getValidMoves`.
 */
import {
  MAX_GEAR_DELTA,
  Player,
  TrackDefinition,
  Vector2D,
  gearOf,
  getTileAt,
  getValidMoves,
  isValidGearChange,
  landingPosition,
  segmentCrossesGrass,
} from './ws-types';

/** Per-bot, per-race memory: where along the racing line the car is. */
export interface BotMemory {
  /** Index (float ok) of the racing-line sample nearest the car. */
  progress: number;
}

export function createBotMemory(): BotMemory {
  // -1 = "not anchored yet": the first move does a global nearest-sample
  // search; afterwards we only search a small window around the last known
  // progress so close parallel sections (Suzuka's crossover) never confuse it.
  return { progress: -1 };
}

/** How many plies the crash-avoidance rollout simulates ahead. */
const ROLLOUT_DEPTH = 6;

/** Window (in samples) searched when re-anchoring progress. */
const PROGRESS_WINDOW = 24;

interface ScoredMove {
  velocity: Vector2D;
  landing: Vector2D;
}

// ---------------------------------------------------------------------------
// Racing line
// ---------------------------------------------------------------------------

const lineCache = new Map<string, Vector2D[]>();
const distanceFieldCache = new Map<string, number[][]>();

/**
 * Resample the centerline into waypoints ~1 cell apart. The track's
 * centerline is a closed loop (first == last point); the duplicate is
 * dropped and indexing wraps modulo the sample count.
 */
export function getRacingLine(track: TrackDefinition): Vector2D[] {
  const cached = lineCache.get(track.id);
  if (cached) return cached;

  const line = track.centerline ?? [];
  const samples: Vector2D[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      samples.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  // Closed loop: the final vertex equals the first, so it is intentionally
  // left out and index math wraps around.
  lineCache.set(track.id, samples);
  return samples;
}

function dist(a: Vector2D, b: Vector2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Nearest sample to `pos` within ±window of `center` (sample index). */
function nearestInWindow(
  samples: Vector2D[],
  pos: Vector2D,
  center: number,
  window: number
): number {
  const n = samples.length;
  const c = Math.round(center);
  let best = c;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let o = -window; o <= window; o++) {
    const idx = (((c + o) % n) + n) % n;
    const d = dist(samples[idx], pos);
    if (d < bestDist) {
      bestDist = d;
      best = idx;
    }
  }
  return best;
}

function nearestGlobal(samples: Vector2D[], pos: Vector2D): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < samples.length; i++) {
    const d = dist(samples[i], pos);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** Forward distance (in samples) between two line indices, wrapped. */
function progressDelta(from: number, to: number, length: number): number {
  return (((to - from) % length) + length + length / 2) % length - length / 2;
}

/**
 * BFS distance (in cells, 8-neighborhood) from every grid cell to the
 * nearest drivable tile. Used by off-track recovery: the goal is "get back
 * to the asphalt", not "gain line progress" — a car parked on a rumble
 * pocket behind a corner otherwise sees every escape move as going backwards
 * and gives up.
 */
export function getTrackDistanceField(track: TrackDefinition): number[][] {
  const cached = distanceFieldCache.get(track.id);
  if (cached) return cached;

  const dist: number[][] = Array.from({ length: track.height }, () =>
    Array.from({ length: track.width }, () => Number.POSITIVE_INFINITY)
  );
  const queue: [number, number][] = [];
  for (let y = 0; y < track.height; y++) {
    for (let x = 0; x < track.width; x++) {
      const t = track.grid[y][x];
      if (t === 'track' || t === 'finish') {
        dist[y][x] = 0;
        queue.push([x, y]);
      }
    }
  }
  let head = 0;
  while (head < queue.length) {
    const [cx, cy] = queue[head++];
    const d = dist[cy][cx] + 1;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= track.width || ny >= track.height) continue;
        if (dist[ny][nx] > d) {
          dist[ny][nx] = d;
          queue.push([nx, ny]);
        }
      }
    }
  }

  distanceFieldCache.set(track.id, dist);
  return dist;
}

// ---------------------------------------------------------------------------
// Move scoring
// ---------------------------------------------------------------------------

/**
 * Existential rollout: is there ANY sequence of gear changes that keeps the
 * car on drivable tiles for `depth` plies? Standing still always survives,
 * so a `false` verdict means the car is genuinely carried into the gravel —
 * which is exactly the braking signal the scorer needs before corners.
 * Memoized per top-level decision: the 9 candidate rollouts share most
 * (x, y, vx, vy) sub-states.
 */
function rolloutSurvives(
  pos: Vector2D,
  vel: Vector2D,
  track: TrackDefinition,
  depth: number,
  memo: Map<string, boolean>
): boolean {
  if (depth === 0) return true;

  const key = `${pos.x},${pos.y},${vel.x},${vel.y},${depth}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let survives = false;
  for (let dvx = -MAX_GEAR_DELTA; dvx <= MAX_GEAR_DELTA && !survives; dvx++) {
    for (let dvy = -MAX_GEAR_DELTA; dvy <= MAX_GEAR_DELTA && !survives; dvy++) {
      const nv: Vector2D = { x: vel.x + dvx, y: vel.y + dvy };
      if (!isValidGearChange(vel, nv, false)) continue;
      const np = landingPosition(pos, nv);
      const tile = getTileAt(track, np.x, np.y);
      if (tile === null || tile === 'grass' || tile === 'rumble') continue;
      if (segmentCrossesGrass(track, pos, np)) continue;
      survives = rolloutSurvives(np, nv, track, depth - 1, memo);
    }
  }

  memo.set(key, survives);
  return survives;
}

/**
 * Off-track recovery scoring: minimize BFS distance to asphalt. Tile
 * penalties stay small on purpose — escaping a gravel trap means driving
 * over grass, so a big per-landing cost makes the bot prefer parking on a
 * rumble strip forever over crossing the grass it must cross.
 */
function scoreEscapeMove(
  player: Player,
  move: ScoredMove,
  track: TrackDefinition,
  samples: Vector2D[],
  memory: BotMemory,
  field: number[][]
): number {
  const tile = getTileAt(track, move.landing.x, move.landing.y);
  let score = -field[move.landing.y][move.landing.x] * 12;
  if (tile === 'grass') score -= 25;
  if (tile === 'rumble') score -= 10;
  if (segmentCrossesGrass(track, player.position, move.landing)) score -= 10;
  const landingProg = nearestInWindow(samples, move.landing, memory.progress, PROGRESS_WINDOW);
  score += progressDelta(memory.progress, landingProg, samples.length) * 2;
  score += gearOf(move.velocity) * 0.5;
  return score;
}

function scoreMove(
  player: Player,
  move: ScoredMove,
  track: TrackDefinition,
  samples: Vector2D[],
  memory: BotMemory,
  memo: Map<string, boolean>
): number {
  const tile = getTileAt(track, move.landing.x, move.landing.y);
  const speed = gearOf(move.velocity);
  let score = 0;

  // Landing in the gravel (or slicing through it) costs the race: stop +
  // gear penalty. Only acceptable when every alternative is worse.
  if (tile === 'grass' || tile === 'rumble') score -= 1000;
  if (segmentCrossesGrass(track, player.position, move.landing)) score -= 1000;

  // Reward forward progress along the racing line. Faster moves cover more
  // line — this is what makes the AI use high gears on straights.
  const landingProg = nearestInWindow(samples, move.landing, memory.progress, PROGRESS_WINDOW);
  score += progressDelta(memory.progress, landingProg, samples.length) * 10;

  // Momentum tie-break — but only when the rollout says we can live with it.
  score += speed;

  if (!rolloutSurvives(move.landing, move.velocity, track, ROLLOUT_DEPTH, memo)) {
    score -= 500;
  }

  return score;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pick the bot's next velocity. Always returns one of the moves the host
 * would accept (via `getValidMoves`), so the AI is legal by construction.
 * `memory` is mutated in place; pass a fresh `createBotMemory()` per race.
 */
export function chooseBotMove(
  player: Player,
  track: TrackDefinition,
  others: Player[],
  round: number,
  memory: BotMemory
): Vector2D {
  const moves = getValidMoves(player, track, others, round);
  if (moves.length === 1) return { ...moves[0].velocity };

  const samples = getRacingLine(track);
  if (samples.length === 0) {
    // Track without a centerline: coast (still legal).
    return { ...moves[0].velocity };
  }

  memory.progress =
    memory.progress < 0
      ? nearestGlobal(samples, player.position)
      : nearestInWindow(samples, player.position, memory.progress, PROGRESS_WINDOW);

  // Off the asphalt? Switch to recovery mode: the only goal is to rejoin.
  if (player.isOffTrack) {
    const field = getTrackDistanceField(track);
    let best = moves[0];
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const move of moves) {
      const score = scoreEscapeMove(player, move, track, samples, memory, field);
      if (score > bestScore) {
        bestScore = score;
        best = move;
      }
    }
    return { ...best.velocity };
  }

  const memo = new Map<string, boolean>();
  let best = moves[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const move of moves) {
    const score = scoreMove(player, move, track, samples, memory, memo);
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return { ...best.velocity };
}
