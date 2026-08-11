/**
 * AI opponent ("bot") brain for Dot Race — pure functions, no I/O.
 * Mirror into frontend/dotrace-app/src/app/core/models/ai.ts.
 *
 * The bot plays by the exact same rules as humans: candidates come from
 * getValidMoves(), so a bot move is always host-legal. Guidance follows the
 * track's racingLine (the centerline polyline, ordered in race direction):
 * the bot aims at a look-ahead point on the line and scores candidate moves
 * with a BFS distance field toward it, plus a one-turn lookahead so higher
 * difficulties brake for corners instead of spinning into the gravel.
 * Following the line keeps bots driving the right way around and naturally
 * routes them through the lap-validity checkpoint zone.
 */
import {
  BotDifficulty,
  GameState,
  Player,
  TrackDefinition,
  Vector2D,
  MAX_GEAR,
  gearOf,
  getTileAt,
  getValidMoves,
} from './ws-types';

/** Tiles a car can sit on without stopping. */
function isDrivable(track: TrackDefinition, x: number, y: number): boolean {
  const tile = getTileAt(track, x, y);
  return tile === 'track' || tile === 'finish';
}

/** Extra turns lost when the follow-up move lands on grass/rumble. */
const OFF_TRACK_PENALTY = 18;
/** Extra turns lost when no follow-up move exists (emergency stop). */
const BOXED_IN_PENALTY = 15;
/** Fallback distance for tiles with no reachable drivable neighbor. */
const UNREACHABLE = 1_000;
/** Look-ahead along the racing line, in tiles, before the speed term. */
const LOOKAHEAD_BASE_TILES = 4;
/** Extra look-ahead tiles per gear — faster cars must see corners earlier. */
const LOOKAHEAD_PER_GEAR = 1.5;
/** racingLine is densified at ~2 samples per tile. */
const SAMPLES_PER_TILE = 2;
/** Weight of the one-turn lookahead relative to the immediate field. */
const FOLLOWUP_WEIGHT = 6;

interface DifficultyProfile {
  /** One-turn lookahead (brake before corners) when true. */
  lookahead: boolean;
  /** Score discount per gear kept — rewards carrying speed. */
  speedBonus: number;
  /** Uniform noise added to each candidate score (also breaks cycles). */
  jitter: number;
  /** Chance of ignoring the plan and picking a random legal move. */
  randomMoveChance: number;
  /** Self-imposed top gear (Chebyshev velocity magnitude). */
  maxGear: number;
}

const DIFFICULTY_PROFILES: Record<BotDifficulty, DifficultyProfile> = {
  // Learns the track slowly: no lookahead, capped at gear 3, sometimes wanders.
  EASY: { lookahead: false, speedBonus: 0, jitter: 8, randomMoveChance: 0.2, maxGear: 3 },
  // Drives safely: brakes for corners but doesn't chase speed.
  MEDIUM: { lookahead: true, speedBonus: 0, jitter: 2, randomMoveChance: 0, maxGear: 5 },
  // Races: lookahead + carries as much speed as the corner allows.
  HARD: { lookahead: true, speedBonus: 1.0, jitter: 0.5, randomMoveChance: 0, maxGear: MAX_GEAR },
};

/** Index of the racing-line sample closest to the car. */
function nearestLineIndex(line: Vector2D[], pos: Vector2D): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < line.length; i++) {
    const dx = line[i].x - pos.x;
    const dy = line[i].y - pos.y;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

function distSq(a: Vector2D, b: Vector2D): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Samples the car can cover in one turn is ≪ this window. */
const TRACKING_WINDOW_SAMPLES = 30;
/** Beyond this distance to the cursor, re-sync against the whole line. */
const RESYNC_DISTANCE_TILES = 10;

/**
 * Advance the bot's line cursor monotonically: the cursor only moves forward
 * (mod loop length) toward the sample nearest the car within a short window.
 * A global nearest-sample pick would oscillate where two corridor sections
 * run close together (e.g. Monza's right flank, Suzuka's crossover), making
 * the look-ahead target jump backwards and the car orbit. The forward-only
 * cursor also keeps bots on the correct branch at crossovers.
 */
function trackLineCursor(line: Vector2D[], player: Player): number {
  const m = line.length;
  let idx = player.botLineIndex ?? -1;
  if (
    idx < 0 ||
    idx >= m ||
    distSq(line[idx], player.position) > RESYNC_DISTANCE_TILES * RESYNC_DISTANCE_TILES
  ) {
    return nearestLineIndex(line, player.position);
  }
  let best = idx;
  let bestDist = distSq(line[idx], player.position);
  for (let k = 1; k <= TRACKING_WINDOW_SAMPLES; k++) {
    const j = (idx + k) % m;
    const d = distSq(line[j], player.position);
    if (d < bestDist) {
      bestDist = d;
      best = j;
    }
  }
  return best;
}

/** Drivable tiles around a line sample (BFS seeds for one move target). */
function targetTilesAround(track: TrackDefinition, center: Vector2D): Vector2D[] {
  const tiles: Vector2D[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (isDrivable(track, center.x + dx, center.y + dy)) {
        tiles.push({ x: center.x + dx, y: center.y + dy });
      }
    }
  }
  if (tiles.length > 0) return tiles;
  // Rounded sample landed off the corridor: scan outward for drivable tiles.
  for (let r = 2; r < Math.max(track.width, track.height); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (isDrivable(track, center.x + dx, center.y + dy)) {
          tiles.push({ x: center.x + dx, y: center.y + dy });
        }
      }
    }
    if (tiles.length > 0) return tiles;
  }
  return [center];
}

/**
 * Multi-source BFS (8-connectivity, matching Chebyshev car movement) from
 * the target tiles over drivable tiles only. field[i] = tile count to the
 * target, Infinity for grass/rumble/outside.
 */
function buildDistanceField(track: TrackDefinition, targets: Vector2D[]): number[] {
  const { width, height } = track;
  const field = new Array<number>(width * height).fill(Number.POSITIVE_INFINITY);
  const queue: number[] = [];
  for (const t of targets) {
    if (t.x < 0 || t.x >= width || t.y < 0 || t.y >= height) continue;
    const idx = t.y * width + t.x;
    if (field[idx] !== 0) {
      field[idx] = 0;
      queue.push(idx);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const x = idx % width;
    const y = Math.floor(idx / width);
    const d = field[idx];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (!isDrivable(track, nx, ny)) continue;
        const nidx = ny * width + nx;
        if (field[nidx] === Number.POSITIVE_INFINITY) {
          field[nidx] = d + 1;
          queue.push(nidx);
        }
      }
    }
  }
  return field;
}

/**
 * Fields are cached per track+line-index: consecutive bot turns (and every
 * bot on the grid) reuse the same handful of look-ahead targets. Cleared
 * wholesale when it grows past a bound — tracks are static, so stale
 * entries are never wrong, just wasted memory.
 */
const FIELD_CACHE_LIMIT = 128;
const fieldCache = new Map<string, number[]>();

function getFieldToLineIndex(track: TrackDefinition, lineIndex: number): number[] {
  const key = `${track.id}:${lineIndex}`;
  let field = fieldCache.get(key);
  if (!field) {
    field = buildDistanceField(track, targetTilesAround(track, track.racingLine[lineIndex]));
    if (fieldCache.size >= FIELD_CACHE_LIMIT) fieldCache.clear();
    fieldCache.set(key, field);
  }
  return field;
}

function fieldAt(field: number[], track: TrackDefinition, p: Vector2D): number {
  if (p.x < 0 || p.x >= track.width || p.y < 0 || p.y >= track.height) return UNREACHABLE;
  return field[p.y * track.width + p.x];
}

/** Approximate distance for a grass/rumble tile via its drivable neighbors. */
function fieldNear(field: number[], track: TrackDefinition, p: Vector2D): number {
  let best = Number.POSITIVE_INFINITY;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const n = { x: p.x + dx, y: p.y + dy };
      if (!isDrivable(track, n.x, n.y)) continue;
      const v = fieldAt(field, track, n);
      if (v < best) best = v;
    }
  }
  return best === Number.POSITIVE_INFINITY ? UNREACHABLE : best + 1;
}

/**
 * Best achievable field value one turn after taking `move`, assuming the
 * ±1 gear rule and MAX_GEAR. Off-paper follow-ups are illegal (skipped);
 * if every follow-up leaves the paper, the real rules force an emergency
 * stop — staying put with zeroed velocity, costed as a penalty.
 */
function bestFollowUpScore(
  velocityAfter: Vector2D,
  landing: Vector2D,
  field: number[],
  track: TrackDefinition
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let dvx = -1; dvx <= 1; dvx++) {
    for (let dvy = -1; dvy <= 1; dvy++) {
      const v2 = { x: velocityAfter.x + dvx, y: velocityAfter.y + dvy };
      if (gearOf(v2) > MAX_GEAR) continue;
      const l2 = { x: landing.x + v2.x, y: landing.y + v2.y };
      const tile = getTileAt(track, l2.x, l2.y);
      if (tile === null) continue;
      const cost =
        tile === 'grass' || tile === 'rumble'
          ? fieldNear(field, track, l2) + OFF_TRACK_PENALTY
          : fieldAt(field, track, l2);
      if (cost < best) best = cost;
    }
  }
  if (best === Number.POSITIVE_INFINITY) {
    best = fieldAt(field, track, landing) + BOXED_IN_PENALTY;
  }
  return best;
}

function scoreMove(
  move: { velocity: Vector2D; landing: Vector2D },
  field: number[],
  track: TrackDefinition,
  profile: DifficultyProfile
): number {
  const tile = getTileAt(track, move.landing.x, move.landing.y);
  const landedOff = tile !== 'track' && tile !== 'finish';
  // Landing in the gravel zeroes the velocity: cost ≈ re-entry distance
  // plus the penalty, and the follow-up crawl starts from a standstill.
  const base = landedOff
    ? fieldNear(field, track, move.landing) + OFF_TRACK_PENALTY
    : fieldAt(field, track, move.landing);
  let score = base * 10;
  if (profile.lookahead) {
    const velocityAfter = landedOff ? { x: 0, y: 0 } : move.velocity;
    score += bestFollowUpScore(velocityAfter, move.landing, field, track) * FOLLOWUP_WEIGHT;
  }
  score -= gearOf(move.velocity) * profile.speedBonus;
  return score;
}

/**
 * Pick the bot's next velocity. Always returns one of the velocities
 * getValidMoves() offers, so the host accepts it exactly like a human move.
 *
 * Side effect: advances player.botLineIndex, the AI scratch cursor on the
 * racing line (see trackLineCursor).
 *
 * @param rng injectable randomness source for deterministic tests.
 */
export function computeBotMove(
  player: Player,
  state: GameState,
  track: TrackDefinition,
  difficulty: BotDifficulty = player.botDifficulty ?? 'MEDIUM',
  rng: () => number = Math.random
): Vector2D {
  const moves = getValidMoves(player, track, state.players, state.round);
  if (moves.length === 1) return { ...moves[0].velocity };

  const line = track.racingLine;
  if (!line || line.length === 0) {
    // Track without a racing line: no guidance possible — coast.
    const coast = moves.find(
      (m) => m.velocity.x === player.velocity.x && m.velocity.y === player.velocity.y
    );
    return { ...(coast ?? moves[0]).velocity };
  }

  const profile = DIFFICULTY_PROFILES[difficulty];
  let candidates = moves.filter((m) => gearOf(m.velocity) <= profile.maxGear);
  if (candidates.length === 0) candidates = moves;

  if (rng() < profile.randomMoveChance) {
    return { ...candidates[Math.floor(rng() * candidates.length)].velocity };
  }

  // Aim at a point on the racing line a few tiles ahead — farther the
  // faster the car goes, so braking zones appear in the field early.
  const here = trackLineCursor(line, player);
  player.botLineIndex = here;
  const aheadSamples = Math.round(
    (LOOKAHEAD_BASE_TILES + gearOf(player.velocity) * LOOKAHEAD_PER_GEAR) * SAMPLES_PER_TILE
  );
  const targetIndex = (here + aheadSamples) % line.length;
  const field = getFieldToLineIndex(track, targetIndex);

  let best = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const move of candidates) {
    const score = scoreMove(move, field, track, profile) + rng() * profile.jitter;
    if (score < bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return { ...best.velocity };
}
