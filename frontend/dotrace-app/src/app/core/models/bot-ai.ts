/**
 * CPU racer planner for "Dot Race" (Vector Rally).
 * Mirror into frontend/dotrace-app/src/app/core/models/bot-ai.ts.
 *
 * Two pieces:
 *
 * 1. A per-track guide, built once and cached, that answers "how far round the
 *    lap is this car?" in a couple of array lookups.
 * 2. A depth-limited search over the ±1 gear rule that maximises progress round
 *    that guide while paying for gravel, kerbs and grass shortcuts. The
 *    lookahead is what makes a bot brake for a corner instead of driving into
 *    the grass at full gear.
 *
 * Progress is measured along the circuit's centerline rather than as a flood
 * fill of the grid, because only the centerline records *lap order*. A flood
 * fill has its minimum immediately behind the stripe (so a bot that trusts it
 * reverses over the line on turn one), and on Suzuka — which crosses itself —
 * it merges the two passes over the crossover and strands the bot there.
 *
 * Everything here is pure: the host drives its bots by feeding in a GameState
 * snapshot and pushing the returned velocity through the same validation a
 * human move goes through.
 */

import {
  BotSkill,
  GameState,
  MAX_GEAR,
  MAX_GEAR_DELTA,
  Player,
  TrackDefinition,
  Vector2D,
  activeRacers,
  gearOf,
  getTileAt,
  getValidMoves,
  isGearLimited,
  isGrassShortcut,
  isTimedMode,
  isValidGearChange,
  landingPosition,
  posKey,
  remainingStopMs,
  segmentCrossesFinish,
  segmentEntersRect,
  zeroVector,
} from './ws-types';

/** Progress cost (in cells) charged for stopping in the gravel or on a kerb. */
const OFF_TRACK_COST = 25;

/** Progress cost (in cells) charged for a grass shortcut and its penalty. */
const GRASS_CUT_COST = 60;

/** Progress cost per cell of run-off between the car and the racing surface. */
const RUNOFF_STEP_COST = 2;

/** Reward per cell of clearance from the track edge, capped at SAFE_CLEARANCE. */
const CLEARANCE_BONUS = 0.5;
const SAFE_CLEARANCE = 3;

const UNSET = -1;

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/**
 * Everything the planner needs to know about a circuit, precomputed per track.
 */
export interface TrackGuide {
  width: number;
  height: number;
  /** Centerline resampled to one cell per step; index 0 sits just past the stripe. */
  path: Vector2D[];
  /** Unit tangent at each path index — which way the lap runs there. */
  tangent: Vector2D[];
  /** Nearest path index for each cell. */
  arcA: Int32Array;
  /**
   * A second, lap-distant path index for cells the circuit visits twice (the
   * Suzuka crossover). -1 where the cell belongs to a single pass.
   */
  arcB: Int32Array;
  /** Steps from the cell to the `arcA` / `arcB` path samples. */
  hopA: Int32Array;
  hopB: Int32Array;
  /** Steps back to the racing surface, 0 on it — the way home for a stranded car. */
  toSurface: Int32Array;
  /** Steps to the nearest non-racing surface, capped when read. */
  clearance: Int32Array;
  /** Cells from which a single move could touch the stripe. */
  nearFinish: Uint8Array;
  /** Last path index inside the lap checkpoint; the gate closes after it. */
  checkpointArc: number;
  /** One lap, in cells. */
  lapLength: number;
  /** Direction cars travel when they cross the stripe. */
  raceDir: Vector2D;
}

export interface BotProfile {
  /** Turns of lookahead, including the move being chosen. */
  depth: number;
  /** Widest gear the planner will select. */
  maxGear: number;
  /** Odds of settling for a merely decent move instead of the best one. */
  mistakeChance: number;
  /** Continuations kept per turn of lookahead. */
  beam: number;
  /** Pause before a turn-based move, so a CPU turn reads as a deliberate move. */
  thinkMs: number;
  /**
   * Pause between moves in a timed race. Far longer than thinkMs, because in a
   * timed race this pause *is* the bot's lap pace: a planner that moved as fast
   * as it can think would get round quicker than anyone can tap a phone.
   */
  paceMs: number;
}

export const BOT_PROFILES: Record<BotSkill, BotProfile> = {
  EASY: { depth: 2, maxGear: 3, mistakeChance: 0.25, beam: 9, thinkMs: 900, paceMs: 2200 },
  MEDIUM: { depth: 3, maxGear: 5, mistakeChance: 0.08, beam: 7, thinkMs: 650, paceMs: 1600 },
  HARD: {
    depth: 4,
    maxGear: MAX_GEAR,
    mistakeChance: 0,
    beam: 6,
    thinkMs: 450,
    paceMs: 1100,
  },
};

export function botProfile(skill: BotSkill | undefined): BotProfile {
  return BOT_PROFILES[skill ?? 'MEDIUM'] ?? BOT_PROFILES.MEDIUM;
}

/** Pause before a turn-based CPU move. */
export function botThinkMs(skill: BotSkill | undefined): number {
  return botProfile(skill).thinkMs;
}

/** Pause between CPU moves in a timed race — effectively the bot's lap pace. */
export function botPaceMs(skill: BotSkill | undefined): number {
  return botProfile(skill).paceMs;
}

/** Grace period after a stop penalty expires before a bot moves again. */
const STOP_PENALTY_GRACE_MS = 150;

/**
 * How long the host should wait before playing this bot's move, or null when
 * the bot is not due to move at all. The pause is what makes a CPU move read as
 * a deliberate move rather than a teleport.
 */
export function botTurnDelayMs(
  state: GameState,
  bot: Player,
  now = Date.now()
): number | null {
  if (state.phase !== 'GAME_ROUND') return null;
  if (bot.finishOrder !== undefined) return null;

  if (isTimedMode(state)) {
    // Everyone races at once, so nothing holds a bot back but a grass-cut stop
    // penalty. Wait that out rather than giving up on the bot: nothing else
    // will emit game state while it ticks down.
    return Math.max(
      botPaceMs(bot.botSkill),
      remainingStopMs(bot, now) + STOP_PENALTY_GRACE_MS
    );
  }
  return state.turnOrder[state.currentTurnIndex] === bot.connectionId
    ? botThinkMs(bot.botSkill)
    : null;
}

// Keyed on the track object rather than its id: tracks are module-level
// constants, and this can never serve a stale guide to a same-named track.
const GUIDE_CACHE = new WeakMap<TrackDefinition, TrackGuide>();

export function trackGuide(track: TrackDefinition): TrackGuide {
  const cached = GUIDE_CACHE.get(track);
  if (cached) return cached;
  const guide = buildGuide(track);
  GUIDE_CACHE.set(track, guide);
  return guide;
}

/** Direction cars travel when they cross the stripe. */
function raceDirection(track: TrackDefinition): Vector2D {
  let sx = 0;
  let sy = 0;
  for (const arrow of track.arrows) {
    sx += arrow.dir.x;
    sy += arrow.dir.y;
  }
  return { x: Math.sign(sx), y: Math.sign(sy) };
}

/** Walk the closed centerline in one-cell steps. */
function resampleCenterline(centerline: Vector2D[]): Vector2D[] {
  const points = [...centerline];
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length > 1 && first.x === last.x && first.y === last.y) points.pop();

  const path: Vector2D[] = [];
  const push = (x: number, y: number): void => {
    const cell = { x: Math.round(x), y: Math.round(y) };
    const prev = path[path.length - 1];
    if (prev && prev.x === cell.x && prev.y === cell.y) return;
    path.push(cell);
  };

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const steps = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y)));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      push(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    }
  }

  // The loop closes, so drop a final duplicate of the very first cell.
  while (path.length > 1) {
    const head = path[0];
    const tail = path[path.length - 1];
    if (head.x !== tail.x || head.y !== tail.y) break;
    path.pop();
  }
  return path;
}

function buildTangents(path: Vector2D[]): Vector2D[] {
  const n = path.length;
  return path.map((_, i) => {
    const back = path[(i - 1 + n) % n];
    const forward = path[(i + 1) % n];
    const dx = forward.x - back.x;
    const dy = forward.y - back.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  });
}

/**
 * Rotate the path so index 0 is the first cell *after* the stripe, and make
 * sure it runs the way the direction flags point.
 */
function alignPathToStripe(
  track: TrackDefinition,
  path: Vector2D[],
  raceDir: Vector2D
): Vector2D[] {
  const onStripe = (p: Vector2D): boolean =>
    getTileAt(track, p.x, p.y) === 'finish';

  const stripeIndexes = path
    .map((p, i) => (onStripe(p) ? i : -1))
    .filter((i) => i >= 0);
  if (stripeIndexes.length === 0) return path;

  const n = path.length;
  // Orient the path along the flags before deciding where the lap starts.
  const at = stripeIndexes[0];
  const forward = path[(at + 1) % n];
  const heading = { x: forward.x - path[at].x, y: forward.y - path[at].y };
  const oriented =
    heading.x * raceDir.x + heading.y * raceDir.y < 0 ? [...path].reverse() : path;

  // Walk forward off the stripe: the cell after the last stripe cell in a row
  // is where a fresh lap begins.
  const start = oriented.findIndex((p) => onStripe(p));
  let exit = start;
  for (let step = 1; step <= oriented.length; step++) {
    const idx = (start + step) % oriented.length;
    if (!onStripe(oriented[idx])) {
      exit = idx;
      break;
    }
  }
  return [...oriented.slice(exit), ...oriented.slice(0, exit)];
}

/**
 * How far from the centerline a cell may be and still count as being under a
 * pass of the circuit. Roughly the half-width of the drawn corridor.
 */
const CORRIDOR_HOPS = 6;

/**
 * Two stretches of the lap only count as crossing when they run at a real
 * angle to each other (|cos| below this). Neighbouring straights that happen
 * to run side by side are not a crossover, and labelling their cells twice
 * would hand a bot a phantom shortcut to the far stretch.
 */
const CROSSING_COS = 0.8;

/**
 * Label every cell with the lap position(s) it belongs to.
 *
 * The primary label spreads over the whole grid, so even a car parked deep in
 * the grass knows where it is. The second label is reserved for cells the
 * circuit genuinely passes over twice — the Suzuka crossover — and is kept
 * inside the corridor and never propagated. Letting it spread would carry a
 * far-side lap position out through the infield grass and back onto the track,
 * where it reads as a huge phantom shortcut.
 */
function labelCells(
  track: TrackDefinition,
  path: Vector2D[],
  tangent: Vector2D[]
): Pick<TrackGuide, 'arcA' | 'arcB' | 'hopA' | 'hopB'> {
  const { width, height } = track;
  const size = width * height;
  const arcA = new Int32Array(size).fill(UNSET);
  const arcB = new Int32Array(size).fill(UNSET);
  const hopA = new Int32Array(size).fill(UNSET);
  const hopB = new Int32Array(size).fill(UNSET);
  const lap = path.length;
  const distinct = Math.max(4, Math.floor(lap / 6));

  const lapGap = (a: number, b: number): number => {
    const raw = Math.abs(a - b);
    return Math.min(raw, lap - raw);
  };

  // Breadth-first from every path sample at once, so each cell is labelled by
  // the lap position that reaches it in the fewest steps.
  const cells: number[] = [];
  const arcs: number[] = [];
  const hops: number[] = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (p.x < 0 || p.x >= width || p.y < 0 || p.y >= height) continue;
    cells.push(p.y * width + p.x);
    arcs.push(i);
    hops.push(0);
  }

  for (let head = 0; head < cells.length; head++) {
    const cell = cells[head];
    const arc = arcs[head];
    const hop = hops[head];

    if (arcA[cell] !== UNSET) {
      if (
        arcB[cell] === UNSET &&
        hop <= CORRIDOR_HOPS &&
        lapGap(arcA[cell], arc) > distinct &&
        crossesAt(tangent[arcA[cell]], tangent[arc])
      ) {
        arcB[cell] = arc;
        hopB[cell] = hop;
      }
      continue;
    }

    arcA[cell] = arc;
    hopA[cell] = hop;

    const x = cell % width;
    const y = (cell - x) / width;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      cells.push(ny * width + nx);
      arcs.push(arc);
      hops.push(hop + 1);
    }
  }

  return { arcA, arcB, hopA, hopB };
}

function crossesAt(a: Vector2D, b: Vector2D): boolean {
  return Math.abs(a.x * b.x + a.y * b.y) < CROSSING_COS;
}

/** Steps from each cell back to the racing surface (0 on it). */
function buildToSurface(track: TrackDefinition): Int32Array {
  const { width, height } = track;
  const toSurface = new Int32Array(width * height).fill(UNSET);
  const queue: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tile = track.grid[y][x];
      if (tile === 'track' || tile === 'finish') {
        const i = y * width + x;
        toSurface[i] = 0;
        queue.push(i);
      }
    }
  }
  expand(queue, toSurface, width, height);
  return toSurface;
}

/** Steps from each cell to the nearest non-racing surface (0 off it). */
function buildClearance(track: TrackDefinition): Int32Array {
  const { width, height } = track;
  const clearance = new Int32Array(width * height).fill(UNSET);
  const queue: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tile = track.grid[y][x];
      if (tile !== 'track' && tile !== 'finish') {
        const i = y * width + x;
        clearance[i] = 0;
        queue.push(i);
      }
    }
  }
  expand(queue, clearance, width, height);
  // A track with no run-off at all: treat every cell as fully clear.
  for (let i = 0; i < clearance.length; i++) {
    if (clearance[i] === UNSET) clearance[i] = SAFE_CLEARANCE;
  }
  return clearance;
}

function expand(queue: number[], dist: Int32Array, width: number, height: number): void {
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const x = i % width;
    const y = (i - x) / width;
    const next = dist[i] + 1;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const j = ny * width + nx;
      if (dist[j] !== UNSET) continue;
      dist[j] = next;
      queue.push(j);
    }
  }
}

/**
 * Cells from which a single move could touch the stripe. A move spans at most
 * MAX_GEAR cells, so anything further away cannot cross the line and can skip
 * the (comparatively expensive) segment scan.
 */
function buildNearFinish(track: TrackDefinition): Uint8Array {
  const { width, height } = track;
  const near = new Uint8Array(width * height);
  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      if (track.grid[cy][cx] !== 'finish') continue;
      for (let y = Math.max(0, cy - MAX_GEAR); y <= Math.min(height - 1, cy + MAX_GEAR); y++) {
        for (let x = Math.max(0, cx - MAX_GEAR); x <= Math.min(width - 1, cx + MAX_GEAR); x++) {
          near[y * width + x] = 1;
        }
      }
    }
  }
  return near;
}

function buildGuide(track: TrackDefinition): TrackGuide {
  const raceDir = raceDirection(track);
  const path = alignPathToStripe(track, resampleCenterline(track.centerline), raceDir);
  const tangent = buildTangents(path);
  const labels = labelCells(track, path, tangent);

  // Where the lap-validity gate closes: the last point of the lap that still
  // lies inside the checkpoint zone. Without a checkpoint the gate is open for
  // the whole lap.
  const rect = track.checkpoint;
  let checkpointArc = path.length - 1;
  if (rect) {
    let last = UNSET;
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      if (p.x >= rect.x0 && p.x <= rect.x1 && p.y >= rect.y0 && p.y <= rect.y1) last = i;
    }
    if (last !== UNSET) checkpointArc = last;
  }

  return {
    width: track.width,
    height: track.height,
    path,
    tangent,
    ...labels,
    toSurface: buildToSurface(track),
    clearance: buildClearance(track),
    nearFinish: buildNearFinish(track),
    checkpointArc,
    lapLength: path.length,
    raceDir,
  };
}

function cellIndex(guide: TrackGuide, p: Vector2D): number {
  if (p.x < 0 || p.x >= guide.width || p.y < 0 || p.y >= guide.height) return UNSET;
  return p.y * guide.width + p.x;
}

/**
 * How far round the lap a car at `position` travelling at `velocity` is.
 *
 * Where the circuit crosses itself a cell belongs to two points of the lap, and
 * only the direction of travel says which — a car heading into the crossover
 * one way is most of a lap behind one heading the other way.
 */
export function lapProgress(
  guide: TrackGuide,
  position: Vector2D,
  velocity: Vector2D
): number {
  const i = cellIndex(guide, position);
  if (i === UNSET) return 0;
  const a = guide.arcA[i];
  if (a === UNSET) return 0;
  const b = guide.arcB[i];
  if (b === UNSET) return a;

  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed === 0) return guide.hopA[i] <= guide.hopB[i] ? a : b;
  const ta = guide.tangent[a];
  const tb = guide.tangent[b];
  const alignA = (ta.x * velocity.x + ta.y * velocity.y) / speed;
  const alignB = (tb.x * velocity.x + tb.y * velocity.y) / speed;
  if (alignA === alignB) return guide.hopA[i] <= guide.hopB[i] ? a : b;
  return alignA > alignB ? a : b;
}

/**
 * Cells left before the current lap can be closed.
 *
 * A car that has run past the lap checkpoint without collecting it owes a whole
 * extra lap — the same rule the host applies, and what stops a bot from taking
 * the Suzuka crossover as a shortcut past the upper loop.
 */
export function remainingFor(
  guide: TrackGuide,
  position: Vector2D,
  velocity: Vector2D,
  passedCheckpoint: boolean
): number {
  const arc = lapProgress(guide, position, velocity);
  const left = guide.lapLength - arc;
  if (passedCheckpoint || arc <= guide.checkpointArc) return left;
  return left + guide.lapLength;
}

function clearanceAt(guide: TrackGuide, p: Vector2D): number {
  const i = cellIndex(guide, p);
  return i === UNSET ? 0 : Math.min(guide.clearance[i], SAFE_CLEARANCE);
}

function runOffDepth(guide: TrackGuide, p: Vector2D): number {
  const i = cellIndex(guide, p);
  if (i === UNSET) return SAFE_CLEARANCE;
  const d = guide.toSurface[i];
  return d === UNSET ? SAFE_CLEARANCE : d;
}

function canTouchFinish(guide: TrackGuide, p: Vector2D): boolean {
  const i = cellIndex(guide, p);
  return i !== UNSET && guide.nearFinish[i] === 1;
}

/** One simulated car state inside the search. */
interface PlanNode {
  position: Vector2D;
  velocity: Vector2D;
  /** Capped to gear 1 (off-track or serving a grass penalty). */
  limited: boolean;
  passedCheckpoint: boolean;
  /** Laps closed since the root of the search. */
  laps: number;
  /** Accumulated progress cost, in cells. */
  cost: number;
}

interface PlanMove {
  velocity: Vector2D;
  landing: Vector2D;
}

function scoreOf(node: PlanNode, guide: TrackGuide): number {
  return (
    node.laps * guide.lapLength -
    remainingFor(guide, node.position, node.velocity, node.passedCheckpoint) -
    runOffDepth(guide, node.position) * RUNOFF_STEP_COST +
    clearanceAt(guide, node.position) * CLEARANCE_BONUS -
    node.cost
  );
}

/**
 * Legal continuations from a simulated state. Mirrors getValidMoves (±1 per
 * axis, gear cap, in-grid landing, no landing on an occupied cell) plus the
 * profile's own gear ceiling, and offers the same emergency stop when the car
 * is boxed in so the search never hits a dead end.
 */
function continuations(
  node: PlanNode,
  track: TrackDefinition,
  blocked: ReadonlySet<string>,
  maxGear: number
): PlanMove[] {
  const moves: PlanMove[] = [];
  for (let dvx = -MAX_GEAR_DELTA; dvx <= MAX_GEAR_DELTA; dvx++) {
    for (let dvy = -MAX_GEAR_DELTA; dvy <= MAX_GEAR_DELTA; dvy++) {
      const velocity = { x: node.velocity.x + dvx, y: node.velocity.y + dvy };
      if (!isValidGearChange(node.velocity, velocity, node.limited)) continue;
      if (gearOf(velocity) > maxGear) continue;
      const landing = landingPosition(node.position, velocity);
      if (getTileAt(track, landing.x, landing.y) === null) continue;
      if (blocked.has(posKey(landing))) continue;
      moves.push({ velocity, landing });
    }
  }
  if (moves.length === 0) {
    moves.push({ velocity: zeroVector(), landing: { ...node.position } });
  }
  return moves;
}

/** Apply a candidate move to a simulated state, charging the usual penalties. */
function advance(
  node: PlanNode,
  move: PlanMove,
  track: TrackDefinition,
  guide: TrackGuide
): PlanNode {
  const from = node.position;
  const landing = move.landing;
  const tile = getTileAt(track, landing.x, landing.y);
  const offTrack = tile === 'grass' || tile === 'rumble';
  const grassCut = isGrassShortcut(track, from, landing);

  let cost =
    node.cost + (offTrack ? OFF_TRACK_COST : 0) + (grassCut ? GRASS_CUT_COST : 0);

  let passedCheckpoint = node.passedCheckpoint;
  if (track.checkpoint && !passedCheckpoint) {
    passedCheckpoint = segmentEntersRect(from, landing, track.checkpoint);
  }

  let laps = node.laps;
  if (canTouchFinish(guide, from) && segmentCrossesFinish(track, from, landing)) {
    if (passedCheckpoint && !offTrack) {
      laps += 1;
      // Same as the host: closing a lap re-arms the checkpoint for the next.
      passedCheckpoint = false;
    } else if (
      move.velocity.x * guide.raceDir.x + move.velocity.y * guide.raceDir.y <
      0
    ) {
      // Backwards over the line. It scores nothing, and on a closed circuit it
      // can look like a shortcut, so make it plainly not worth doing.
      cost += guide.lapLength;
    }
  }

  return {
    position: landing,
    velocity: offTrack ? zeroVector() : move.velocity,
    limited: offTrack || grassCut,
    passedCheckpoint,
    laps,
    cost,
  };
}

function bestOutcome(
  node: PlanNode,
  track: TrackDefinition,
  guide: TrackGuide,
  blocked: ReadonlySet<string>,
  profile: BotProfile,
  depth: number
): number {
  if (depth <= 0) return scoreOf(node, guide);

  const children = continuations(node, track, blocked, profile.maxGear).map((move) =>
    advance(node, move, track, guide)
  );
  children.sort((a, b) => scoreOf(b, guide) - scoreOf(a, guide));

  const width = Math.min(profile.beam, children.length);
  let best = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < width; i++) {
    const score = bestOutcome(children[i], track, guide, blocked, profile, depth - 1);
    if (score > best) best = score;
  }
  return best;
}

export interface BotPlanInput {
  bot: Player;
  track: TrackDefinition;
  /** Everyone in the race, for collision avoidance. */
  players: Player[];
  round: number;
  /** Overrides the skill stored on the bot player. */
  skill?: BotSkill;
}

/**
 * Pick the velocity a CPU racer should play, or null when it has no move.
 * The result is always one of getValidMoves, so the host can push it through
 * the same validation as a human move.
 */
export function planBotMove(
  input: BotPlanInput,
  random: () => number = Math.random
): Vector2D | null {
  const { bot, track, players, round } = input;
  const legal = getValidMoves(bot, track, players, round);
  if (legal.length === 0) return null;
  if (legal.length === 1) return legal[0].velocity;

  const profile = botProfile(input.skill ?? bot.botSkill);
  const guide = trackGuide(track);
  const blocked = new Set(
    activeRacers(players, bot.connectionId).map((p) => posKey(p.position))
  );

  const root: PlanNode = {
    position: { ...bot.position },
    velocity: { ...bot.velocity },
    limited: isGearLimited(bot, round),
    // Tracks without a checkpoint leave the flag undefined, which counts as
    // passed — same rule the host applies when closing a lap.
    passedCheckpoint: bot.passedCheckpoint !== false,
    laps: 0,
    cost: 0,
  };

  // Honour the profile's gear ceiling, unless the car is already going faster
  // than it and the ±1 rule leaves nothing under the cap.
  const capped = legal.filter((m) => gearOf(m.velocity) <= profile.maxGear);
  const options = capped.length > 0 ? capped : legal;

  const ranked = options
    .map((move) => ({
      velocity: move.velocity,
      score: bestOutcome(
        advance(root, move, track, guide),
        track,
        guide,
        blocked,
        profile,
        profile.depth - 1
      ),
    }))
    .sort((a, b) => b.score - a.score);

  // Weaker bots sometimes settle for a near-miss instead of the best line.
  if (ranked.length > 1 && random() < profile.mistakeChance) {
    const slip = 1 + Math.floor(random() * 2);
    return ranked[Math.min(slip, ranked.length - 1)].velocity;
  }
  return ranked[0].velocity;
}

/** Convenience wrapper for the host, which always has the full GameState. */
export function chooseBotMove(
  state: GameState,
  bot: Player,
  track: TrackDefinition,
  random: () => number = Math.random
): Vector2D | null {
  return planBotMove(
    { bot, track, players: state.players, round: state.round },
    random
  );
}
