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
