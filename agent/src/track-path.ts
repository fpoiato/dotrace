/**
 * Track-aware helpers for the AI pilot.
 *
 * Plain BFS to the checkpoint on a loop picks the short *wrong-way* route.
 * Instead we project asphalt cells onto the directed centerline and measure
 * forward distance along race direction to the current segment goal. Look-ahead
 * and overspeed checks still use the asphalt mask for accel/brake.
 */
import {
  CheckpointRect,
  TrackDefinition,
  Vector2D,
  getTileAt,
} from '../../shared/ws-types';

function cellKey(p: Vector2D): string {
  return `${p.x},${p.y}`;
}

/** Racing surface the pilot should stay on (not grass/rumble/void). */
export function isAsphalt(track: TrackDefinition, p: Vector2D): boolean {
  const tile = getTileAt(track, p.x, p.y);
  return tile === 'track' || tile === 'finish';
}

export function speedOf(v: Vector2D): number {
  return Math.max(Math.abs(v.x), Math.abs(v.y));
}

export function cellsInRect(track: TrackDefinition, rect: CheckpointRect): Vector2D[] {
  const cells: Vector2D[] = [];
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      const p = { x, y };
      if (isAsphalt(track, p)) cells.push(p);
    }
  }
  return cells;
}

export function finishCells(track: TrackDefinition): Vector2D[] {
  const cells: Vector2D[] = [];
  for (let y = 0; y < track.height; y++) {
    for (let x = 0; x < track.width; x++) {
      if (getTileAt(track, x, y) === 'finish') cells.push({ x, y });
    }
  }
  return cells;
}

export function segmentGoals(
  track: TrackDefinition,
  passedCheckpoint: boolean
): Vector2D[] {
  if (track.checkpoint && !passedCheckpoint) {
    const cells = cellsInRect(track, track.checkpoint);
    if (cells.length > 0) return cells;
  }
  return finishCells(track);
}

/** Unique centerline vertices (drop duplicate closing point). */
export function racingLine(track: TrackDefinition): Vector2D[] {
  const line = track.centerline;
  if (line.length < 2) return line;
  const last = line[line.length - 1]!;
  const first = line[0]!;
  if (last.x === first.x && last.y === first.y) {
    return line.slice(0, -1);
  }
  return line;
}

/** Resample the closed racing line at ~1-cell spacing so nearest-vertex works. */
export function densifyRacingLine(line: Vector2D[], spacing = 1): Vector2D[] {
  if (line.length < 2) return line;
  const out: Vector2D[] = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[i]!;
    const b = line[(i + 1) % line.length]!;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(dist / spacing));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      });
    }
  }
  return out;
}

function nearestLineIndex(line: Vector2D[], p: Vector2D): number {
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < line.length; i++) {
    const q = line[i]!;
    const d = (q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Forward steps along a closed line from `from` to `to` (mod L). */
export function forwardDelta(from: number, to: number, length: number): number {
  return (to - from + length) % length;
}

function headingAt(line: Vector2D[], index: number): Vector2D {
  const L = line.length;
  const a = line[index]!;
  const b = line[(index + 1) % L]!;
  return { x: b.x - a.x, y: b.y - a.y };
}

function turnLabel(prev: Vector2D, next: Vector2D): 'straight' | 'left' | 'right' | 'hairpin' {
  const len1 = Math.hypot(prev.x, prev.y) || 1;
  const len2 = Math.hypot(next.x, next.y) || 1;
  const dot = (prev.x * next.x + prev.y * next.y) / (len1 * len2);
  const cross = prev.x * next.y - prev.y * next.x;
  const angle = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
  if (angle < 20) return 'straight';
  if (angle > 110) return 'hairpin';
  return cross < 0 ? 'right' : 'left';
}

export type TrafficAlignment = 'with_traffic' | 'across' | 'against' | 'stopped';

/**
 * Human/LLM-readable snapshot of where the car sits on the directed circuit.
 * Gives Bedrock (and logs) visibility the raw grid coords alone do not.
 */
export interface TrackSituation {
  trackId: string;
  /** 0–100 along the directed racing line (this lap). */
  lapProgressPct: number;
  /** Approximate cells along the line to the current goal. */
  cellsToGoal: number;
  /** Racing-line tangent at the nearest point (race direction). */
  raceHeading: { x: number; y: number };
  /** Current velocity (travel direction). */
  travelHeading: { x: number; y: number };
  /** Whether travel matches race direction. */
  alignment: TrafficAlignment;
  /** Chebyshev distance from car to nearest racing-line sample. */
  lateralOffset: number;
  tileUnderCar: string;
  /** How many densified cells until the line bends ≥ ~25°. */
  cellsToCorner: number | null;
  /** Direction of that bend. Null on a straight. */
  cornerTurn: 'left' | 'right' | 'hairpin' | null;
  /** Soft max gear from asphalt look-ahead along the race heading. */
  suggestedMaxGear: number;
  /** Upcoming racing-line samples ahead of the car. */
  ahead: Array<{
    cellsAhead: number;
    heading: { x: number; y: number };
    turn: 'straight' | 'left' | 'right' | 'hairpin';
  }>;
}

/** Build a compact situation report for prompts / debugging. */
export function describeTrackSituation(
  track: TrackDefinition,
  position: Vector2D,
  velocity: Vector2D,
  passedCheckpoint: boolean
): TrackSituation {
  const line = densifyRacingLine(racingLine(track), 1);
  const L = line.length || 1;
  const idx = line.length ? nearestLineIndex(line, position) : 0;
  const nearest = line[idx] ?? position;
  const raceHeading = line.length ? headingAt(line, idx) : { x: 1, y: 0 };
  // Quantize heading for stable JSON / easier model reading.
  const rh = {
    x: Math.round(raceHeading.x * 10) / 10,
    y: Math.round(raceHeading.y * 10) / 10,
  };

  const speed = speedOf(velocity);
  let alignment: TrafficAlignment = 'stopped';
  if (speed > 0) {
    const rLen = Math.hypot(raceHeading.x, raceHeading.y) || 1;
    const dot =
      (raceHeading.x * velocity.x + raceHeading.y * velocity.y) / (rLen * speed);
    if (dot > 0.35) alignment = 'with_traffic';
    else if (dot < -0.35) alignment = 'against';
    else alignment = 'across';
  }

  const goals = segmentGoals(track, passedCheckpoint);
  let cellsToGoal = L;
  for (const g of goals) {
    const gi = nearestLineIndex(line, g);
    const d = forwardDelta(idx, gi, L);
    if (d < cellsToGoal) cellsToGoal = d;
  }
  if (!goals.length) cellsToGoal = 0;

  let cellsToCorner: number | null = null;
  let cornerTurn: TrackSituation['cornerTurn'] = null;
  const ahead: TrackSituation['ahead'] = [];
  const sampleAt = [3, 6, 10, 16, 24];
  let prevHeading = raceHeading;
  for (let step = 1; step <= 24; step++) {
    const h = headingAt(line, (idx + step) % L);
    const turn = turnLabel(prevHeading, h);
    if (cellsToCorner === null && turn !== 'straight') {
      cellsToCorner = step;
      cornerTurn = turn;
    }
    prevHeading = h;
  }
  for (const cellsAhead of sampleAt) {
    const at = (idx + cellsAhead) % L;
    const h = headingAt(line, at);
    const prev = headingAt(line, (at - 1 + L) % L);
    ahead.push({
      cellsAhead,
      heading: { x: Math.round(h.x * 10) / 10, y: Math.round(h.y * 10) / 10 },
      turn: turnLabel(prev, h),
    });
  }

  // 1-cell step along the dominant race-heading axes for asphalt look-ahead.
  const stepV = {
    x:
      Math.abs(raceHeading.x) < 0.35
        ? 0
        : raceHeading.x > 0
          ? 1
          : -1,
    y:
      Math.abs(raceHeading.y) < 0.35
        ? 0
        : raceHeading.y > 0
          ? 1
          : -1,
  };
  if (stepV.x === 0 && stepV.y === 0) {
    stepV.x = 1;
  }
  const clear = asphaltLookahead(track, position, stepV, 12);
  const suggestedMaxGear = Math.max(
    1,
    Math.min(6, Math.floor(Math.sqrt(Math.max(1, clear * 1.6))))
  );

  return {
    trackId: track.id,
    lapProgressPct: Math.round((idx / L) * 1000) / 10,
    cellsToGoal,
    raceHeading: rh,
    travelHeading: { x: velocity.x, y: velocity.y },
    alignment,
    lateralOffset: Math.max(
      Math.abs(nearest.x - position.x),
      Math.abs(nearest.y - position.y)
    ),
    tileUnderCar: getTileAt(track, position.x, position.y) ?? 'void',
    cellsToCorner,
    cornerTurn,
    suggestedMaxGear,
    ahead,
  };
}

/**
 * Directed distance field: for each asphalt cell, how far forward along the
 * racing line until the nearest goal cell (also projected onto the line).
 */
export function buildDistanceField(
  track: TrackDefinition,
  goals: Vector2D[]
): Map<string, number> {
  const dist = new Map<string, number>();
  const line = densifyRacingLine(racingLine(track), 1);
  if (line.length === 0 || goals.length === 0) return dist;

  const L = line.length;
  const goalIdxs = goals.map((g) => nearestLineIndex(line, g));

  const vertexForward = new Array<number>(L);
  for (let i = 0; i < L; i++) {
    let best = L;
    for (const g of goalIdxs) {
      const d = forwardDelta(i, g, L);
      if (d < best) best = d;
    }
    vertexForward[i] = best;
  }

  for (let y = 0; y < track.height; y++) {
    for (let x = 0; x < track.width; x++) {
      const p = { x, y };
      if (!isAsphalt(track, p)) continue;
      const idx = nearestLineIndex(line, p);
      const nearest = line[idx]!;
      const lateral = Math.max(
        Math.abs(nearest.x - x),
        Math.abs(nearest.y - y)
      );
      // Densified spacing ≈ 1 cell, so vertex index ≈ along-track distance.
      dist.set(cellKey(p), vertexForward[idx]! + lateral * 0.35);
    }
  }

  return dist;
}

export function pathDistance(field: Map<string, number>, p: Vector2D): number {
  return field.get(cellKey(p)) ?? Number.POSITIVE_INFINITY;
}

/**
 * How many asphalt cells lie ahead when repeatedly stepping by `velocity`
 * (capped). Used to decide whether accelerating is safe.
 */
export function asphaltLookahead(
  track: TrackDefinition,
  from: Vector2D,
  velocity: Vector2D,
  maxSteps = 14
): number {
  const vx = velocity.x;
  const vy = velocity.y;
  if (vx === 0 && vy === 0) return 0;
  let steps = 0;
  let pos = { ...from };
  for (let i = 0; i < maxSteps; i++) {
    pos = { x: pos.x + vx, y: pos.y + vy };
    if (!isAsphalt(track, pos)) break;
    steps++;
  }
  return steps;
}

/**
 * True when pure braking toward zero (shrink each axis by 1 per turn) would
 * leave the asphalt before stopping.
 */
export function isOverspeed(
  track: TrackDefinition,
  pos: Vector2D,
  velocity: Vector2D
): boolean {
  const s = speedOf(velocity);
  if (s <= 1) return false;

  let v = { ...velocity };
  let p = { ...pos };
  for (let turn = 0; turn < s + 2; turn++) {
    const nx = v.x === 0 ? 0 : v.x > 0 ? v.x - 1 : v.x + 1;
    const ny = v.y === 0 ? 0 : v.y > 0 ? v.y - 1 : v.y + 1;
    v = { x: nx, y: ny };
    p = { x: p.x + v.x, y: p.y + v.y };
    if (!isAsphalt(track, p)) return true;
    if (v.x === 0 && v.y === 0) return false;
  }
  return false;
}

export interface PathAnnotation {
  pathDistance: number;
  pathProgress: number;
  clearAhead: number;
  overspeed: boolean;
}

export function annotatePath(
  track: TrackDefinition,
  from: Vector2D,
  candidateVelocity: Vector2D,
  landing: Vector2D,
  field: Map<string, number>
): PathAnnotation {
  const pathDist = pathDistance(field, landing);
  const fromDist = pathDistance(field, from);
  const pathProgress =
    (Number.isFinite(fromDist) ? fromDist : 1e9) -
    (Number.isFinite(pathDist) ? pathDist : 1e9);
  return {
    pathDistance: pathDist,
    pathProgress,
    clearAhead: asphaltLookahead(track, landing, candidateVelocity),
    overspeed: isOverspeed(track, landing, candidateVelocity),
  };
}

/** Cache directed fields per (trackId, goal set) across turns. */
export class TrackPathCache {
  private fields = new Map<string, Map<string, number>>();

  get(track: TrackDefinition, goals: Vector2D[]): Map<string, number> {
    const goalKey = goals
      .map((g) => cellKey(g))
      .sort()
      .join('|');
    const cacheKey = `${track.id}::${goalKey}`;
    let field = this.fields.get(cacheKey);
    if (!field) {
      field = buildDistanceField(track, goals);
      this.fields.set(cacheKey, field);
    }
    return field;
  }

  clear(): void {
    this.fields.clear();
  }
}

export const sharedPathCache = new TrackPathCache();
