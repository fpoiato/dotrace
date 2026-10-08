import { TileType, TrackArrow, TrackDefinition, Vector2D } from './ws-types';

/**
 * Circuits are rasterized from a centerline polyline stamped with a round
 * brush, mimicking a marker pen on grid paper. Layouts follow the
 * classic outlines of Monza, Monaco, Interlagos, Silverstone, Spa and Suzuka.
 */

const GRID_W = 84;
const GRID_H = 54;
const BRUSH_RADIUS = 3.5; // corridor ≈ 7 cells wide

function emptyGrid(w: number, h: number): TileType[][] {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => 'grass' as TileType));
}

function stampDisc(grid: TileType[][], cx: number, cy: number, r: number): void {
  const h = grid.length;
  const w = grid[0].length;
  const minY = Math.max(0, Math.floor(cy - r));
  const maxY = Math.min(h - 1, Math.ceil(cy + r));
  const minX = Math.max(0, Math.floor(cx - r));
  const maxX = Math.min(w - 1, Math.ceil(cx + r));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) {
        grid[y][x] = 'track';
      }
    }
  }
}

function carvePolyline(grid: TileType[][], points: Vector2D[], radius = BRUSH_RADIUS): void {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(dist * 4));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      stampDisc(grid, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, radius);
    }
  }
}

/** Convert existing track cells inside the rect into the finish stripe. */
function stampFinish(grid: TileType[][], x0: number, x1: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (grid[y]?.[x] === 'track') {
        grid[y][x] = 'finish';
      }
    }
  }
}

/** Twelve staggered grid slots marching away from the stripe (horizontal straight). */
function gridSlots(firstCol: number, colStep: number, rows: [number, number]): Vector2D[] {
  const slots: Vector2D[] = [];
  for (let i = 0; i < 6; i++) {
    const x = firstCol + i * colStep;
    slots.push({ x, y: rows[0] }, { x, y: rows[1] });
  }
  return slots;
}

/** Twelve staggered grid slots along a vertical straight. */
function gridSlotsVertical(cols: [number, number], firstRow: number, rowStep: number): Vector2D[] {
  const slots: Vector2D[] = [];
  for (let i = 0; i < 6; i++) {
    const y = firstRow + i * rowStep;
    slots.push({ x: cols[0], y }, { x: cols[1], y });
  }
  return slots;
}

interface CircuitSpec {
  id: string;
  nameKey: string;
  centerline: Vector2D[];
  finish: { x0: number; x1: number; y0: number; y1: number };
  startLine: Vector2D[];
  arrows: TrackArrow[];
  checkpoint: { x0: number; y0: number; x1: number; y1: number };
  /**
   * Authoring boxes for DRS. The blue area is the asphalt between the
   * perpendicular cuts where the centerline enters and leaves each box.
   */
  drsZones?: { x0: number; y0: number; x1: number; y1: number }[];
  /** Optional per-circuit grid size (defaults to GRID_W × GRID_H). */
  width?: number;
  height?: number;
}

function hasTrackNeighbor(grid: TileType[][], x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const t = grid[y + dy]?.[x + dx];
      if (t === 'track' || t === 'finish') return true;
    }
  }
  return false;
}

/** Kerb rumble strips on grass cells beside the track at sharp corners. */
function stampCornerRumble(grid: TileType[][], centerline: Vector2D[]): void {
  const h = grid.length;
  const w = grid[0].length;
  const CORNER_DEG = 28;
  const REACH = 5;

  for (let i = 1; i < centerline.length - 1; i++) {
    const prev = centerline[i - 1];
    const curr = centerline[i];
    const next = centerline[i + 1];
    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const len1 = Math.hypot(v1x, v1y);
    const len2 = Math.hypot(v2x, v2y);
    if (len1 < 0.01 || len2 < 0.01) continue;

    const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
    const angle = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
    if (angle < CORNER_DEG) continue;

    for (let dy = -REACH; dy <= REACH; dy++) {
      for (let dx = -REACH; dx <= REACH; dx++) {
        const x = Math.round(curr.x + dx);
        const y = Math.round(curr.y + dy);
        if (y < 0 || y >= h || x < 0 || x >= w) continue;
        if (grid[y][x] !== 'grass') continue;
        if (hasTrackNeighbor(grid, x, y)) {
          grid[y][x] = 'rumble';
        }
      }
    }
  }
}

/**
 * Close short grass holes along the track edge inside a rumble strip so the
 * black ink boundary doesn't interrupt the zebra mid-corner. Only fills cells
 * that sit between rumble on both sides along the edge (does not grow the strip).
 */
function sealRumbleGaps(grid: TileType[][], maxGap = 4): void {
  const h = grid.length;
  const w = grid[0].length;
  const ortho = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ] as const;

  const fill: Array<[number, number]> = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[y][x] !== 'grass') continue;

      for (const [tdx, tdy] of ortho) {
        const toward = grid[y + tdy]?.[x + tdx];
        if (toward !== 'track' && toward !== 'finish') continue;

        // Lateral walk along the shared edge (perpendicular to track normal).
        const lx = -tdy;
        const ly = tdx;
        const hasRumble = (dir: 1 | -1): boolean => {
          for (let step = 1; step <= maxGap; step++) {
            const sx = x + lx * dir * step;
            const sy = y + ly * dir * step;
            if (sy < 0 || sy >= h || sx < 0 || sx >= w) return false;
            const t = grid[sy][sx];
            if (t === 'rumble') return true;
            if (t !== 'grass') return false;
          }
          return false;
        };

        if (hasRumble(1) && hasRumble(-1)) {
          fill.push([x, y]);
          break;
        }
      }
    }
  }
  for (const [x, y] of fill) grid[y][x] = 'rumble';
}

function buildCircuit(spec: CircuitSpec): TrackDefinition {
  const width = spec.width ?? GRID_W;
  const height = spec.height ?? GRID_H;
  const grid = emptyGrid(width, height);
  carvePolyline(grid, spec.centerline);
  stampCornerRumble(grid, spec.centerline);
  // Tight hairpins can leave gaps wider than one seal pass can close.
  sealRumbleGaps(grid);
  sealRumbleGaps(grid);
  stampFinish(grid, spec.finish.x0, spec.finish.x1, spec.finish.y0, spec.finish.y1);
  return {
    id: spec.id,
    nameKey: spec.nameKey,
    width,
    height,
    grid,
    startLine: placeGridBeforeFinish(grid, spec),
    arrows: spec.arrows,
    centerline: spec.centerline.map((p) => ({ ...p })),
    checkpoint: spec.checkpoint,
    drsZones: spec.drsZones?.map((z) => ({ ...z })),
  };
}

/**
 * Twelve staggered slots on the asphalt just behind the stripe.
 * Sample the centerline continuously: vertex hops on a long straight used to
 * drop cars a whole segment (~30 cells) apart and far from the checkered line.
 * Neighbours stay within 3 cells (2 back, 2 across).
 */
function placeGridBeforeFinish(grid: TileType[][], spec: CircuitSpec): Vector2D[] {
  const dir = spec.arrows[0]?.dir ?? { x: 1, y: 0 };
  const len = Math.hypot(dir.x, dir.y) || 1;
  const dx = dir.x / len;
  const dy = dir.y / len;
  const line = spec.centerline;
  const n = line.length;
  if (n < 2) return spec.startLine;

  const segLen: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = line[i];
    const b = line[(i + 1) % n];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    segLen.push(L);
    total += L;
  }
  if (total < 1) return spec.startLine;

  const cx = (spec.finish.x0 + spec.finish.x1) / 2;
  const cy = (spec.finish.y0 + spec.finish.y1) / 2;

  let bestS = 0;
  let bestD = Infinity;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const a = line[i];
    const b = line[(i + 1) % n];
    const L = segLen[i];
    const denom = L * L || 1;
    const t = Math.max(0, Math.min(1, ((cx - a.x) * (b.x - a.x) + (cy - a.y) * (b.y - a.y)) / denom));
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    const d = Math.hypot(px - cx, py - cy);
    if (d < bestD) {
      bestD = d;
      bestS = acc + L * t;
    }
    acc += L;
  }

  const pointAt = (s: number): { x: number; y: number; tx: number; ty: number } => {
    let u = ((s % total) + total) % total;
    for (let i = 0; i < n; i++) {
      const L = segLen[i];
      if (u <= L || i === n - 1) {
        const a = line[i];
        const b = line[(i + 1) % n];
        const t = L > 0 ? Math.min(1, u / L) : 0;
        const vx = b.x - a.x;
        const vy = b.y - a.y;
        const vl = Math.hypot(vx, vy) || 1;
        return { x: a.x + vx * t, y: a.y + vy * t, tx: vx / vl, ty: vy / vl };
      }
      u -= L;
    }
    return { x: line[0].x, y: line[0].y, tx: dx, ty: dy };
  };

  const here = pointAt(bestS);
  // Increasing arc length is upstream when the tangent opposes the race direction.
  let upstreamSign = here.tx * dx + here.ty * dy >= 0 ? -1 : 1;
  const behind = (s: number): number => {
    const p = pointAt(s);
    return (p.x - cx) * dx + (p.y - cy) * dy;
  };
  if (behind(bestS + upstreamSign * 2) > behind(bestS - upstreamSign * 2)) upstreamSign *= -1;

  const inFinish = (x: number, y: number): boolean =>
    x >= spec.finish.x0 - 0.5 &&
    x <= spec.finish.x1 + 0.5 &&
    y >= spec.finish.y0 - 0.5 &&
    y <= spec.finish.y1 + 0.5;

  // First row sits one cell behind the stripe, not on it and not a segment away.
  let back = 0.5;
  while (back < 12 && inFinish(pointAt(bestS + upstreamSign * back).x, pointAt(bestS + upstreamSign * back).y)) {
    back += 0.5;
  }
  back += 1;

  const used = new Set<string>();
  const snap = (x: number, y: number): Vector2D | null => {
    for (let r = 0; r <= 3; r++) {
      for (let oy = -r; oy <= r; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
          const nx = Math.round(x + ox);
          const ny = Math.round(y + oy);
          if (grid[ny]?.[nx] !== 'track') continue;
          const key = `${nx},${ny}`;
          if (used.has(key)) continue;
          used.add(key);
          return { x: nx, y: ny };
        }
      }
    }
    return null;
  };

  const slots: Vector2D[] = [];
  const ROW_GAP = 2;
  const LAT = 1.15;
  for (let row = 0; row < 6 && slots.length < 12; row++) {
    const p = pointAt(bestS + upstreamSign * (back + row * ROW_GAP));
    const nx = -p.ty;
    const ny = p.tx;
    const left = snap(p.x + nx * LAT, p.y + ny * LAT);
    const right = snap(p.x - nx * LAT, p.y - ny * LAT);
    // Stagger so car N+2 sits beside the previous row, still within 3 cells.
    if (row % 2 === 0) {
      if (left) slots.push(left);
      if (right) slots.push(right);
    } else {
      if (right) slots.push(right);
      if (left) slots.push(left);
    }
  }
  return slots.length > 0 ? slots : spec.startLine;
}

/**
 * Monza — enlarged clockwise GP outline. Long bottom straight (race left),
 * Variante del Rettifilo and Curva Grande on the left, Roggia and the Lesmos
 * across the top, Ascari chicane, then the Parabolica back onto the straight.
 */
const MONZA: CircuitSpec = {
  id: 'monza',
  nameKey: 'tracks.monza',
  width: 214,
  height: 132,
  centerline: [
    // Pit straight — race left toward the Rettifilo
    { x: 168, y: 118 },
    { x: 138, y: 118 },
    { x: 108, y: 118 },
    { x: 86, y: 118 },
    // Variante del Rettifilo — right, then left
    { x: 74, y: 106 },
    { x: 60, y: 116 },
    { x: 48, y: 106 },
    // Curva Grande
    { x: 38, y: 96 },
    { x: 30, y: 84 },
    { x: 24, y: 68 },
    { x: 20, y: 52 },
    { x: 22, y: 40 },
    // Variante della Roggia — left lane, then back right
    { x: 22, y: 32 },
    { x: 10, y: 26 },
    { x: 10, y: 18 },
    { x: 24, y: 12 },
    // Lesmo 1 and Lesmo 2
    { x: 38, y: 8 },
    { x: 52, y: 10 },
    { x: 62, y: 18 },
    { x: 68, y: 28 },
    // Serraglio
    { x: 78, y: 42 },
    { x: 92, y: 56 },
    { x: 108, y: 70 },
    // Variante Ascari — left, right, left, long enough to rotate
    { x: 124, y: 82 },
    { x: 144, y: 76 },
    { x: 160, y: 88 },
    { x: 176, y: 82 },
    // Straight into the Parabolica
    { x: 192, y: 90 },
    { x: 202, y: 98 },
    { x: 206, y: 108 },
    { x: 204, y: 116 },
    { x: 194, y: 122 },
    { x: 180, y: 122 },
    { x: 170, y: 118 },
    { x: 168, y: 118 },
  ],
  finish: { x0: 124, x1: 126, y0: 112, y1: 125 },
  // Race goes left. Grid sits upstream of the stripe and marches away from it.
  startLine: gridSlots(130, 3, [116, 119]),
  arrows: [
    { at: { x: 125, y: 110 }, dir: { x: -1, y: 0 } },
    { at: { x: 125, y: 126 }, dir: { x: -1, y: 0 } },
  ],
  checkpoint: { x0: 20, y0: 6, x1: 52, y1: 20 },
  // Pit straight, the long right-hand Curva Grande after the Rettifilo, and
  // the Serraglio. Off the grid, the stripe, and the Lesmo checkpoint.
  drsZones: [
    { x0: 127, y0: 108, x1: 196, y1: 128 },
    { x0: 16, y0: 38, x1: 46, y1: 100 },
    { x0: 70, y0: 26, x1: 118, y1: 78 },
  ],
};

/**
 * Monaco — enlarged clockwise GP. The pit straight races east toward
 * Sainte Devote, the hairpin sits at the top-right, and the harbour, pool
 * and Rascasse run along the bottom.
 */
const MONACO: CircuitSpec = {
  id: 'monaco',
  nameKey: 'tracks.monaco',
  width: 170,
  height: 194,
  centerline: [
    { x: 35, y: 92 },
    { x: 42, y: 90 },
    { x: 49, y: 88 },
    { x: 57, y: 86 },
    { x: 63, y: 85 },
    { x: 70, y: 83 },
    { x: 77, y: 82 },
    { x: 83, y: 80 },
    { x: 90, y: 78 },
    { x: 97, y: 77 },
    { x: 102, y: 72 },
    { x: 105, y: 66 },
    { x: 104, y: 61 },
    { x: 99, y: 56 },
    { x: 97, y: 53 },
    { x: 100, y: 47 },
    { x: 104, y: 41 },
    { x: 108, y: 36 },
    { x: 112, y: 30 },
    { x: 118, y: 22 },
    { x: 128, y: 18 },
    { x: 138, y: 18 },
    { x: 146, y: 24 },
    { x: 148, y: 34 },
    { x: 144, y: 42 },
    { x: 136, y: 48 },
    { x: 134, y: 54 },
    { x: 132, y: 60 },
    { x: 128, y: 66 },
    { x: 124, y: 72 },
    { x: 119, y: 77 },
    { x: 114, y: 82 },
    { x: 108, y: 85 },
    { x: 101, y: 88 },
    { x: 95, y: 90 },
    { x: 88, y: 92 },
    { x: 81, y: 93 },
    { x: 76, y: 97 },
    { x: 69, y: 98 },
    { x: 63, y: 99 },
    { x: 56, y: 100 },
    { x: 49, y: 101 },
    { x: 42, y: 102 },
    { x: 36, y: 105 },
    { x: 33, y: 111 },
    { x: 32, y: 116 },
    { x: 32, y: 123 },
    { x: 35, y: 128 },
    { x: 35, y: 134 },
    { x: 36, y: 141 },
    { x: 37, y: 148 },
    { x: 37, y: 154 },
    { x: 43, y: 158 },
    { x: 48, y: 161 },
    { x: 54, y: 165 },
    { x: 54, y: 168 },
    { x: 52, y: 171 },
    { x: 47, y: 172 },
    { x: 42, y: 169 },
    { x: 35, y: 166 },
    { x: 29, y: 160 },
    { x: 26, y: 153 },
    { x: 24, y: 147 },
    { x: 23, y: 140 },
    { x: 21, y: 134 },
    { x: 18, y: 128 },
    { x: 18, y: 120 },
    { x: 18, y: 111 },
    { x: 20, y: 103 },
    { x: 23, y: 96 },
    { x: 28, y: 92 },
    { x: 35, y: 92 },
  ],
  finish: { x0: 32, x1: 38, y0: 84, y1: 100 },
  // Race goes east. Grid sits upstream of the stripe.
  startLine: gridSlots(28, -3, [90, 94]),
  arrows: [
    { at: { x: 37, y: 101 }, dir: { x: 1, y: 0 } },
    { at: { x: 33, y: 83 }, dir: { x: 1, y: 0 } },
  ],
  checkpoint: { x0: 136, y0: 15, x1: 153, y1: 31 },
  // Climb to the hairpin, the pit straight east of the stripe, and a long
  // strip on the opposite (westbound) straight. Starts at x 40 so it does
  // not cover the finish stripe (x 32–38).
  drsZones: [
    { x0: 90, y0: 18, x1: 126, y1: 58 },
    { x0: 42, y0: 78, x1: 88, y1: 88 },
    { x0: 40, y0: 90, x1: 98, y1: 110 },
  ],
};

/**
 * Interlagos — enlarged anticlockwise GP. The north straight races
 * west into the Senna S, the left side drops to the bottom sweep, and the
 * long right side climbs back with the infield loop inside.
 */
const INTERLAGOS: CircuitSpec = {
  id: 'interlagos',
  nameKey: 'tracks.interlagos',
  width: 124,
  height: 166,
  centerline: [
    { x: 63, y: 18 },
    { x: 56, y: 18 },
    { x: 49, y: 20 },
    { x: 42, y: 22 },
    { x: 36, y: 26 },
    { x: 31, y: 31 },
    { x: 26, y: 36 },
    { x: 23, y: 43 },
    { x: 23, y: 52 },
    { x: 22, y: 57 },
    { x: 20, y: 62 },
    { x: 18, y: 70 },
    { x: 18, y: 79 },
    { x: 21, y: 87 },
    { x: 23, y: 93 },
    { x: 25, y: 100 },
    { x: 28, y: 105 },
    { x: 29, y: 109 },
    { x: 31, y: 116 },
    { x: 32, y: 123 },
    { x: 34, y: 130 },
    { x: 36, y: 137 },
    { x: 38, y: 143 },
    { x: 45, y: 144 },
    { x: 51, y: 141 },
    { x: 58, y: 142 },
    { x: 64, y: 144 },
    { x: 71, y: 143 },
    { x: 77, y: 140 },
    { x: 81, y: 134 },
    { x: 84, y: 128 },
    { x: 86, y: 121 },
    { x: 88, y: 114 },
    { x: 89, y: 108 },
    { x: 91, y: 101 },
    { x: 93, y: 94 },
    { x: 95, y: 87 },
    { x: 96, y: 80 },
    { x: 98, y: 74 },
    { x: 100, y: 67 },
    { x: 102, y: 60 },
    { x: 101, y: 53 },
    { x: 95, y: 50 },
    { x: 88, y: 49 },
    { x: 81, y: 50 },
    { x: 75, y: 54 },
    { x: 71, y: 59 },
    { x: 67, y: 65 },
    { x: 63, y: 70 },
    { x: 59, y: 76 },
    { x: 54, y: 82 },
    { x: 50, y: 87 },
    { x: 44, y: 90 },
    { x: 39, y: 89 },
    { x: 34, y: 84 },
    { x: 33, y: 77 },
    { x: 32, y: 72 },
    { x: 34, y: 69 },
    { x: 37, y: 67 },
    { x: 40, y: 68 },
    { x: 43, y: 66 },
    { x: 44, y: 63 },
    { x: 43, y: 58 },
    { x: 40, y: 54 },
    { x: 38, y: 48 },
    { x: 37, y: 40 },
    { x: 41, y: 39 },
    { x: 45, y: 44 },
    { x: 50, y: 49 },
    { x: 57, y: 50 },
    { x: 64, y: 47 },
    { x: 68, y: 42 },
    { x: 72, y: 36 },
    { x: 76, y: 30 },
    { x: 76, y: 24 },
    { x: 70, y: 20 },
    { x: 63, y: 18 },
  ],
  finish: { x0: 62, x1: 64, y0: 10, y1: 26 },
  // Race goes west. Grid sits upstream of the stripe.
  startLine: gridSlots(68, 2, [18, 22]),
  arrows: [
    { at: { x: 63, y: 9 }, dir: { x: -1, y: 0 } },
    { at: { x: 63, y: 27 }, dir: { x: -1, y: 0 } },
  ],
  checkpoint: { x0: 72, y0: 127, x1: 88, y1: 144 },
  // Right climb (above the checkpoint) and the left descent. Off the stripe.
  drsZones: [
    { x0: 78, y0: 58, x1: 110, y1: 126 },
    { x0: 14, y0: 46, x1: 27, y1: 110 },
  ],
};

/**
 * Silverstone — enlarged clockwise GP. The start is on the northern
 * straight racing east toward Abbey, Wellington runs down the right, and
 * Club returns to the straight.
 */
const SILVERSTONE: CircuitSpec = {
  id: 'silverstone',
  nameKey: 'tracks.silverstone',
  width: 141,
  height: 193,
  centerline: [
    { x: 61, y: 22 },
    { x: 68, y: 21 },
    { x: 75, y: 20 },
    { x: 82, y: 19 },
    { x: 89, y: 19 },
    { x: 96, y: 18 },
    { x: 103, y: 18 },
    { x: 108, y: 23 },
    { x: 111, y: 30 },
    { x: 112, y: 37 },
    { x: 113, y: 43 },
    { x: 114, y: 50 },
    { x: 114, y: 57 },
    { x: 115, y: 64 },
    { x: 118, y: 71 },
    { x: 119, y: 78 },
    { x: 117, y: 85 },
    { x: 118, y: 92 },
    { x: 119, y: 98 },
    { x: 116, y: 103 },
    { x: 111, y: 108 },
    { x: 106, y: 113 },
    { x: 103, y: 119 },
    { x: 100, y: 125 },
    { x: 96, y: 131 },
    { x: 93, y: 138 },
    { x: 90, y: 144 },
    { x: 86, y: 150 },
    { x: 83, y: 156 },
    { x: 79, y: 162 },
    { x: 75, y: 168 },
    { x: 70, y: 171 },
    { x: 63, y: 170 },
    { x: 59, y: 164 },
    { x: 55, y: 158 },
    { x: 51, y: 153 },
    { x: 40, y: 150 },
    { x: 28, y: 144 },
    { x: 20, y: 134 },
    { x: 18, y: 122 },
    { x: 24, y: 112 },
    { x: 36, y: 104 },
    { x: 46, y: 100 },
    { x: 53, y: 98 },
    { x: 59, y: 94 },
    { x: 66, y: 95 },
    { x: 73, y: 95 },
    { x: 80, y: 93 },
    { x: 85, y: 89 },
    { x: 91, y: 84 },
    { x: 95, y: 85 },
    { x: 98, y: 87 },
    { x: 98, y: 89 },
    { x: 101, y: 90 },
    { x: 104, y: 87 },
    { x: 105, y: 79 },
    { x: 102, y: 74 },
    { x: 99, y: 70 },
    { x: 94, y: 65 },
    { x: 89, y: 60 },
    { x: 83, y: 55 },
    { x: 78, y: 51 },
    { x: 73, y: 46 },
    { x: 68, y: 41 },
    { x: 62, y: 37 },
    { x: 57, y: 38 },
    { x: 56, y: 45 },
    { x: 52, y: 48 },
    { x: 49, y: 48 },
    { x: 46, y: 45 },
    { x: 47, y: 37 },
    { x: 50, y: 31 },
    { x: 55, y: 25 },
    { x: 61, y: 22 },
  ],
  finish: { x0: 59, x1: 63, y0: 14, y1: 30 },
  // Race goes east. Grid sits upstream of the stripe.
  startLine: gridSlots(55, -3, [22, 26]),
  arrows: [
    { at: { x: 62, y: 31 }, dir: { x: 1, y: 0 } },
    { at: { x: 60, y: 13 }, dir: { x: 1, y: 0 } },
  ],
  checkpoint: { x0: 52, y0: 157, x1: 68, y1: 173 },
  drsZones: [{ x0: 78, y0: 100, x1: 124, y1: 154 }],
};

/**
 * Spa-Francorchamps — enlarged clockwise GP in the classic gun
 * shape. The pit straight runs toward La Source, then Eau Rouge and Kemmel
 * climb to Les Combes, Pouhon and Blanchimont.
 */
const SPA: CircuitSpec = {
  id: 'spa',
  nameKey: 'tracks.spa',
  width: 134,
  height: 192,
  centerline: [
    { x: 60, y: 140 },
    { x: 57, y: 146 },
    { x: 51, y: 148 },
    { x: 44, y: 148 },
    { x: 39, y: 152 },
    { x: 35, y: 158 },
    { x: 29, y: 162 },
    { x: 23, y: 160 },
    { x: 18, y: 155 },
    { x: 18, y: 148 },
    { x: 20, y: 142 },
    { x: 25, y: 136 },
    { x: 29, y: 131 },
    { x: 35, y: 127 },
    { x: 41, y: 123 },
    { x: 47, y: 120 },
    { x: 53, y: 116 },
    { x: 57, y: 110 },
    { x: 60, y: 104 },
    { x: 62, y: 97 },
    { x: 61, y: 90 },
    { x: 59, y: 84 },
    { x: 56, y: 77 },
    { x: 55, y: 70 },
    { x: 54, y: 64 },
    { x: 56, y: 57 },
    { x: 56, y: 50 },
    { x: 53, y: 44 },
    { x: 49, y: 38 },
    { x: 46, y: 32 },
    { x: 43, y: 26 },
    { x: 39, y: 20 },
    { x: 43, y: 18 },
    { x: 49, y: 21 },
    { x: 55, y: 24 },
    { x: 60, y: 29 },
    { x: 65, y: 34 },
    { x: 69, y: 40 },
    { x: 74, y: 45 },
    { x: 79, y: 50 },
    { x: 83, y: 55 },
    { x: 85, y: 62 },
    { x: 88, y: 68 },
    { x: 92, y: 74 },
    { x: 95, y: 80 },
    { x: 98, y: 86 },
    { x: 100, y: 93 },
    { x: 102, y: 100 },
    { x: 104, y: 106 },
    { x: 106, y: 113 },
    { x: 108, y: 120 },
    { x: 110, y: 127 },
    { x: 112, y: 133 },
    { x: 112, y: 140 },
    { x: 110, y: 147 },
    { x: 110, y: 154 },
    { x: 107, y: 160 },
    { x: 102, y: 164 },
    { x: 97, y: 168 },
    { x: 92, y: 170 },
    { x: 89, y: 169 },
    { x: 88, y: 168 },
    { x: 89, y: 165 },
    { x: 92, y: 162 },
    { x: 95, y: 156 },
    { x: 94, y: 149 },
    { x: 92, y: 143 },
    { x: 90, y: 136 },
    { x: 89, y: 129 },
    { x: 87, y: 122 },
    { x: 82, y: 118 },
    { x: 75, y: 118 },
    { x: 69, y: 121 },
    { x: 66, y: 127 },
    { x: 63, y: 133 },
    { x: 60, y: 140 },
  ],
  finish: { x0: 52, x1: 68, y0: 135, y1: 145 },
  // Race goes south. Grid sits upstream of the stripe.
  startLine: gridSlotsVertical([54, 58], 131, -2),
  arrows: [
    { at: { x: 52, y: 136 }, dir: { x: 0, y: 1 } },
    { at: { x: 68, y: 144 }, dir: { x: 0, y: 1 } },
  ],
  checkpoint: { x0: 36, y0: 11, x1: 52, y1: 26 },
  drsZones: [{ x0: 98, y0: 76, x1: 118, y1: 148 }],
};

/**
 * Suzuka — enlarged figure-eight. The start is on the east straight,
 * the two loops cross in the middle, and the hairpin closes the upper loop.
 */
const SUZUKA: CircuitSpec = {
  id: 'suzuka',
  nameKey: 'tracks.suzuka',
  width: 204,
  height: 146,
  centerline: [
    { x: 161, y: 87 },
    { x: 165, y: 92 },
    { x: 170, y: 98 },
    { x: 174, y: 103 },
    { x: 179, y: 109 },
    { x: 182, y: 115 },
    { x: 181, y: 122 },
    { x: 177, y: 124 },
    { x: 174, y: 124 },
    { x: 170, y: 121 },
    { x: 166, y: 115 },
    { x: 162, y: 110 },
    { x: 155, y: 108 },
    { x: 150, y: 104 },
    { x: 147, y: 97 },
    { x: 142, y: 93 },
    { x: 135, y: 91 },
    { x: 130, y: 87 },
    { x: 131, y: 80 },
    { x: 131, y: 73 },
    { x: 128, y: 69 },
    { x: 123, y: 68 },
    { x: 116, y: 68 },
    { x: 111, y: 70 },
    { x: 106, y: 75 },
    { x: 101, y: 80 },
    { x: 96, y: 85 },
    { x: 89, y: 94 },
    { x: 87, y: 94 },
    { x: 80, y: 83 },
    { x: 76, y: 77 },
    { x: 75, y: 70 },
    { x: 74, y: 63 },
    { x: 66, y: 54 },
    { x: 56, y: 50 },
    { x: 48, y: 54 },
    { x: 49, y: 56 },
    { x: 46, y: 53 },
    { x: 46, y: 48 },
    { x: 44, y: 43 },
    { x: 40, y: 37 },
    { x: 37, y: 31 },
    { x: 34, y: 25 },
    { x: 29, y: 20 },
    { x: 23, y: 18 },
    { x: 18, y: 23 },
    { x: 19, y: 30 },
    { x: 24, y: 34 },
    { x: 30, y: 39 },
    { x: 34, y: 43 },
    { x: 34, y: 48 },
    { x: 37, y: 57 },
    { x: 42, y: 63 },
    { x: 47, y: 69 },
    { x: 53, y: 71 },
    { x: 58, y: 76 },
    { x: 64, y: 74 },
    { x: 75, y: 75 },
    { x: 82, y: 76 },
    { x: 89, y: 74 },
    { x: 92, y: 67 },
    { x: 97, y: 62 },
    { x: 102, y: 58 },
    { x: 109, y: 54 },
    { x: 117, y: 54 },
    { x: 124, y: 52 },
    { x: 131, y: 54 },
    { x: 137, y: 59 },
    { x: 142, y: 64 },
    { x: 146, y: 69 },
    { x: 151, y: 74 },
    { x: 155, y: 80 },
    { x: 156, y: 82 },
    { x: 161, y: 87 },
  ],
  finish: { x0: 154, x1: 168, y0: 81, y1: 93 },
  // Race goes south. Grid sits upstream of the stripe.
  startLine: gridSlotsVertical([158, 162], 76, -2),
  arrows: [
    { at: { x: 154, y: 93 }, dir: { x: 0, y: 1 } },
    { at: { x: 168, y: 81 }, dir: { x: 0, y: 1 } },
  ],
  checkpoint: { x0: 27, y0: 19, x1: 43, y1: 35 },
  drsZones: [{ x0: 112, y0: 69, x1: 141, y1: 98 }],
};

export const TRACKS: TrackDefinition[] = [
  buildCircuit(MONZA),
  buildCircuit(MONACO),
  buildCircuit(INTERLAGOS),
  buildCircuit(SILVERSTONE),
  buildCircuit(SPA),
  buildCircuit(SUZUKA),
];

export function getTrackById(id: string): TrackDefinition | undefined {
  return TRACKS.find((t) => t.id === id);
}

/** Paper-sketch palette used by the canvas renderer. */
export const PAPER_COLORS = {
  paper: '#fbfaf6',
  gridLine: '#d8dee4',
  grass: '#22b422',
  ink: '#111111',
  finish: '#f97316',
  finishDark: '#111111',
  rumbleRed: '#dc2626',
  rumbleWhite: '#ffffff',
};

export const TILE_COLORS: Record<TileType, string> = {
  track: PAPER_COLORS.paper,
  grass: PAPER_COLORS.grass,
  finish: PAPER_COLORS.finish,
  rumble: PAPER_COLORS.grass,
};
