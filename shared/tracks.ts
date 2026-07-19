import { TileType, TrackArrow, TrackDefinition, Vector2D } from './ws-types';

/**
 * Circuits are rasterized from a centerline polyline stamped with a round
 * brush, mimicking a marker pen on grid paper. Layouts approximate the
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
    startLine: spec.startLine,
    arrows: spec.arrows,
    checkpoint: spec.checkpoint,
  };
}

/**
 * Monza — elongated clockwise ring: long bottom start straight, Parabolica
 * sweeping up on the right, back straight climbing to the top-left (Lesmo
 * side), tall left flank returning down to the line.
 */
const MONZA: CircuitSpec = {
  id: 'monza',
  nameKey: 'tracks.monza',
  centerline: [
    { x: 18, y: 48 },
    { x: 66, y: 48 },
    { x: 75, y: 44 },
    { x: 78, y: 35 },
    { x: 71, y: 26 },
    { x: 51, y: 17 },
    { x: 30, y: 9 },
    { x: 17, y: 5 },
    { x: 9, y: 9 },
    { x: 9, y: 18 },
    { x: 14, y: 30 },
    { x: 17, y: 41 },
    { x: 18, y: 48 },
  ],
  finish: { x0: 42, x1: 44, y0: 44, y1: 53 },
  startLine: gridSlots(47, 3, [47, 50]),
  arrows: [
    { at: { x: 43, y: 41 }, dir: { x: 1, y: 0 } },
    { at: { x: 43, y: 53 }, dir: { x: 1, y: 0 } },
  ],
  checkpoint: { x0: 5, y0: 2, x1: 30, y1: 18 },
};

/**
 * Monaco — anticlockwise street loop: low tail around the left (Rascasse),
 * climb up the left edge, run along the top to the casino hook at the
 * top-right, then squeeze back left along the harbour straight.
 */
const MONACO: CircuitSpec = {
  id: 'monaco',
  nameKey: 'tracks.monaco',
  centerline: [
    { x: 15, y: 45 },
    { x: 9, y: 39 },
    { x: 8, y: 30 },
    { x: 11, y: 21 },
    { x: 18, y: 15 },
    { x: 30, y: 18 },
    { x: 42, y: 21 },
    { x: 54, y: 18 },
    { x: 63, y: 12 },
    { x: 72, y: 11 },
    { x: 77, y: 17 },
    { x: 72, y: 24 },
    { x: 63, y: 29 },
    { x: 51, y: 32 },
    { x: 36, y: 32 },
    { x: 23, y: 36 },
    { x: 15, y: 45 },
  ],
  finish: { x0: 45, x1: 47, y0: 26, y1: 38 },
  startLine: gridSlots(42, -2, [30, 33]),
  arrows: [
    { at: { x: 46, y: 23 }, dir: { x: -1, y: 0 } },
    { at: { x: 46, y: 40 }, dir: { x: -1, y: 0 } },
  ],
  checkpoint: { x0: 63, y0: 6, x1: 81, y1: 27 },
};

/**
 * Interlagos — anticlockwise: top start straight running right-to-left,
 * left bulge diving down, infield S climbing back up and curling around
 * (Senna S / Bico de Pato), bottom sweep and the long right side back up.
 */
const INTERLAGOS: CircuitSpec = {
  id: 'interlagos',
  nameKey: 'tracks.interlagos',
  centerline: [
    { x: 69, y: 11 },
    { x: 45, y: 8 },
    { x: 24, y: 8 },
    { x: 14, y: 12 },
    { x: 9, y: 21 },
    { x: 11, y: 30 },
    { x: 18, y: 35 },
    { x: 26, y: 32 },
    { x: 30, y: 24 },
    { x: 38, y: 20 },
    { x: 45, y: 23 },
    { x: 47, y: 30 },
    { x: 41, y: 36 },
    { x: 33, y: 42 },
    { x: 39, y: 47 },
    { x: 51, y: 47 },
    { x: 63, y: 44 },
    { x: 72, y: 36 },
    { x: 77, y: 26 },
    { x: 75, y: 17 },
    { x: 69, y: 11 },
  ],
  finish: { x0: 45, x1: 47, y0: 3, y1: 14 },
  startLine: gridSlots(42, -3, [6, 9]),
  arrows: [
    { at: { x: 46, y: 2 }, dir: { x: -1, y: 0 } },
    { at: { x: 46, y: 16 }, dir: { x: -1, y: 0 } },
  ],
  checkpoint: { x0: 66, y0: 18, x1: 81, y1: 42 },
};

/**
 * Silverstone — larger clockwise circuit: tight top hairpin, long right-hand
 * descent, bottom bump/chicane and bulbous left turn, tall infield “n” loop
 * with a left-middle bay, then the climb back to the hairpin.
 */
const SILVERSTONE: CircuitSpec = {
  id: 'silverstone',
  nameKey: 'tracks.silverstone',
  width: 120,
  height: 78,
  centerline: [
    // Top hairpin
    { x: 24, y: 11 },
    { x: 30, y: 5 },
    { x: 39, y: 3 },
    { x: 48, y: 5 },
    { x: 54, y: 11 },
    // Top-right sweep into the long right straight
    { x: 72, y: 15 },
    { x: 87, y: 21 },
    { x: 99, y: 30 },
    { x: 108, y: 42 },
    { x: 111, y: 54 },
    { x: 111, y: 63 },
    // Bottom-right 90° left
    { x: 105, y: 71 },
    { x: 93, y: 74 },
    { x: 78, y: 74 },
    // Bottom bump / chicane
    { x: 69, y: 72 },
    { x: 63, y: 66 },
    { x: 57, y: 71 },
    // Bottom-left bulb
    { x: 42, y: 74 },
    { x: 27, y: 71 },
    { x: 18, y: 63 },
    // Tall infield n-loop (ascend right leg, round peak, descend left leg)
    { x: 30, y: 57 },
    { x: 45, y: 51 },
    { x: 60, y: 45 },
    { x: 72, y: 42 },
    { x: 81, y: 39 },
    { x: 84, y: 33 },
    { x: 78, y: 27 },
    { x: 66, y: 24 },
    { x: 54, y: 26 },
    { x: 42, y: 30 },
    { x: 33, y: 36 },
    { x: 24, y: 39 },
    // Left straight up to the hairpin
    { x: 18, y: 30 },
    { x: 15, y: 21 },
    { x: 18, y: 14 },
    { x: 24, y: 11 },
  ],
  // Horizontal stripe across the vertical start/finish straight (race goes up)
  finish: { x0: 11, x1: 24, y0: 32, y1: 33 },
  startLine: gridSlotsVertical([15, 18], 29, -3),
  arrows: [
    { at: { x: 8, y: 32 }, dir: { x: 0, y: -1 } },
    { at: { x: 26, y: 32 }, dir: { x: 0, y: -1 } },
  ],
  checkpoint: { x0: 102, y0: 45, x1: 117, y1: 66 },
};

/**
 * Spa-Francorchamps — classic “gun” silhouette matching the croqui: La Source
 * hairpin at bottom-left, Eau Rouge kink climbing the left flank into Kemmel,
 * Les Combes at the top, Pouhon as a wide right-hand ear, then Fagnes /
 * Stavelot / Blanchimont returning to the pit straight (S/F before La Source).
 */
const SPA: CircuitSpec = {
  id: 'spa',
  nameKey: 'tracks.spa',
  width: 120,
  height: 78,
  centerline: [
    // Pit straight → La Source (race left). S/F on this stretch.
    { x: 48, y: 71 },
    { x: 30, y: 71 },
    { x: 18, y: 69 },
    // La Source — tight 180, exit upward
    { x: 9, y: 66 },
    { x: 5, y: 60 },
    { x: 5, y: 54 },
    { x: 11, y: 51 },
    { x: 17, y: 51 },
    // Eau Rouge / Raidillon — R-L-R kink climbing the left flank
    { x: 23, y: 48 },
    { x: 32, y: 44 },
    { x: 23, y: 39 },
    { x: 29, y: 33 },
    { x: 21, y: 27 },
    // Kemmel Straight — long climb hugging the left edge
    { x: 17, y: 20 },
    { x: 15, y: 12 },
    { x: 21, y: 6 },
    { x: 30, y: 3 },
    // Les Combes / Malmedy — tight top hook
    { x: 42, y: 3 },
    { x: 54, y: 5 },
    { x: 60, y: 9 },
    { x: 57, y: 15 },
    { x: 51, y: 18 },
    // Toward Pouhon
    { x: 54, y: 24 },
    { x: 60, y: 30 },
    { x: 66, y: 33 },
    // Pouhon — prominent right ear
    { x: 78, y: 33 },
    { x: 93, y: 35 },
    { x: 105, y: 39 },
    { x: 111, y: 45 },
    { x: 111, y: 51 },
    { x: 105, y: 56 },
    { x: 93, y: 57 },
    // Smooth exit into Blanchimont / pit (no back-fold island)
    { x: 81, y: 60 },
    { x: 72, y: 65 },
    { x: 63, y: 69 },
    { x: 54, y: 71 },
    { x: 48, y: 71 },
  ],
  finish: { x0: 36, x1: 38, y0: 66, y1: 75 },
  startLine: gridSlots(33, -3, [69, 72]),
  arrows: [
    { at: { x: 37, y: 64 }, dir: { x: -1, y: 0 } },
    { at: { x: 37, y: 76 }, dir: { x: -1, y: 0 } },
  ],
  checkpoint: { x0: 99, y0: 36, x1: 117, y1: 57 },
};

/**
 * Suzuka — figure-eight matching the croqui: S/F on the lower-right flank
 * racing UP into the central crossover, upper loop with a tight hairpin at
 * the top, then a wide right-hand turn into the sweeping bottom bulb that
 * returns to the line.
 */
const SUZUKA: CircuitSpec = {
  id: 'suzuka',
  nameKey: 'tracks.suzuka',
  width: 120,
  height: 78,
  centerline: [
    // S/F straight — tall vertical right flank, race UP into the crossover
    { x: 92, y: 62 },
    { x: 92, y: 54 },
    { x: 92, y: 46 },
    { x: 90, y: 38 },
    { x: 82, y: 32 },
    // Crossover (SE → NW) into the upper loop
    { x: 68, y: 26 },
    { x: 54, y: 20 },
    // Wide sweeping left-hand turn
    { x: 40, y: 14 },
    { x: 30, y: 9 },
    // Tight U-shaped hairpin at the top
    { x: 34, y: 4 },
    { x: 46, y: 3 },
    { x: 58, y: 3 },
    { x: 70, y: 5 },
    { x: 78, y: 10 },
    // Wide left-hand turn heading back down to the crossover
    { x: 80, y: 18 },
    { x: 74, y: 26 },
    { x: 62, y: 32 },
    // Crossover (NE → SW) into the lower loop
    { x: 48, y: 38 },
    // Large wide right-hand turn onto the west side
    { x: 34, y: 46 },
    { x: 24, y: 54 },
    { x: 20, y: 60 },
    // Long sweeping left-hand bulb along the bottom
    { x: 22, y: 67 },
    { x: 34, y: 72 },
    { x: 50, y: 73 },
    { x: 68, y: 73 },
    { x: 82, y: 70 },
    { x: 90, y: 66 },
    { x: 92, y: 62 },
  ],
  // Horizontal stripe across the vertical S/F straight (race goes up)
  finish: { x0: 84, x1: 100, y0: 55, y1: 56 },
  startLine: gridSlotsVertical([89, 93], 53, -3),
  arrows: [
    { at: { x: 82, y: 55 }, dir: { x: 0, y: -1 } },
    { at: { x: 102, y: 55 }, dir: { x: 0, y: -1 } },
  ],
  checkpoint: { x0: 40, y0: 1, x1: 72, y1: 12 },
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
