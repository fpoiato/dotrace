import { CheckpointRect, TileType, TrackArrow, TrackDefinition, Vector2D } from './ws-types';

/**
 * Circuits are rasterized from a centerline polyline stamped with a round
 * brush, mimicking a marker pen on grid paper. Monza, Monaco, Interlagos and
 * Silverstone approximate the classic outlines; Spa-Francorchamps is a
 * stylized rendition of the real lap, and Suzuka is a Vector-Racer style
 * maze whose colored gates must be swept in order.
 */

const GRID_W = 56;
const GRID_H = 36;
const BRUSH_RADIUS = 2.3; // corridor ≈ 5 cells wide

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

/** Twelve staggered grid slots marching away from the stripe. */
function gridSlots(firstCol: number, colStep: number, rows: [number, number]): Vector2D[] {
  const slots: Vector2D[] = [];
  for (let i = 0; i < 6; i++) {
    const x = firstCol + i * colStep;
    slots.push({ x, y: rows[0] }, { x, y: rows[1] });
  }
  return slots;
}

/** Twelve staggered grid slots for a vertical start straight. */
function gridSlotsVertical(firstRow: number, rowStep: number, cols: [number, number]): Vector2D[] {
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
  checkpoints: CheckpointRect[];
}

function buildCircuit(spec: CircuitSpec): TrackDefinition {
  const grid = emptyGrid(GRID_W, GRID_H);
  carvePolyline(grid, spec.centerline);
  stampFinish(grid, spec.finish.x0, spec.finish.x1, spec.finish.y0, spec.finish.y1);
  return {
    id: spec.id,
    nameKey: spec.nameKey,
    width: GRID_W,
    height: GRID_H,
    grid,
    startLine: spec.startLine,
    arrows: spec.arrows,
    checkpoints: spec.checkpoints,
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
    { x: 12, y: 32 },
    { x: 44, y: 32 },
    { x: 50, y: 29 },
    { x: 52, y: 23 },
    { x: 47, y: 17 },
    { x: 34, y: 11 },
    { x: 20, y: 6 },
    { x: 11, y: 3 },
    { x: 6, y: 6 },
    { x: 6, y: 12 },
    { x: 9, y: 20 },
    { x: 11, y: 27 },
    { x: 12, y: 32 },
  ],
  finish: { x0: 28, x1: 29, y0: 29, y1: 35 },
  startLine: gridSlots(31, 2, [31, 33]),
  arrows: [
    { at: { x: 28.5, y: 27.5 }, dir: { x: 1, y: 0 } },
    { at: { x: 28.5, y: 35.4 }, dir: { x: 1, y: 0 } },
  ],
  checkpoints: [{ x0: 3, y0: 1, x1: 20, y1: 12 }],
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
    { x: 10, y: 30 },
    { x: 6, y: 26 },
    { x: 5, y: 20 },
    { x: 7, y: 14 },
    { x: 12, y: 10 },
    { x: 20, y: 12 },
    { x: 28, y: 14 },
    { x: 36, y: 12 },
    { x: 42, y: 8 },
    { x: 48, y: 7 },
    { x: 51, y: 11 },
    { x: 48, y: 16 },
    { x: 42, y: 19 },
    { x: 34, y: 21 },
    { x: 24, y: 21 },
    { x: 15, y: 24 },
    { x: 10, y: 30 },
  ],
  finish: { x0: 30, x1: 31, y0: 17, y1: 25 },
  startLine: gridSlots(28, -1, [20, 22]),
  arrows: [
    { at: { x: 30.5, y: 15.5 }, dir: { x: -1, y: 0 } },
    { at: { x: 30.5, y: 26.5 }, dir: { x: -1, y: 0 } },
  ],
  checkpoints: [{ x0: 42, y0: 4, x1: 54, y1: 18 }],
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
    { x: 46, y: 7 },
    { x: 30, y: 5 },
    { x: 16, y: 5 },
    { x: 9, y: 8 },
    { x: 6, y: 14 },
    { x: 7, y: 20 },
    { x: 12, y: 23 },
    { x: 17, y: 21 },
    { x: 20, y: 16 },
    { x: 25, y: 13 },
    { x: 30, y: 15 },
    { x: 31, y: 20 },
    { x: 27, y: 24 },
    { x: 22, y: 28 },
    { x: 26, y: 31 },
    { x: 34, y: 31 },
    { x: 42, y: 29 },
    { x: 48, y: 24 },
    { x: 51, y: 17 },
    { x: 50, y: 11 },
    { x: 46, y: 7 },
  ],
  finish: { x0: 30, x1: 31, y0: 2, y1: 9 },
  startLine: gridSlots(28, -2, [4, 6]),
  arrows: [
    { at: { x: 30.5, y: 1.2 }, dir: { x: -1, y: 0 } },
    { at: { x: 30.5, y: 10.5 }, dir: { x: -1, y: 0 } },
  ],
  checkpoints: [{ x0: 44, y0: 12, x1: 54, y1: 28 }],
};

/**
 * Silverstone — clockwise: long bottom start straight, sweeping right-hand
 * complex at the top (Maggotts / Becketts feel), left flank dropping through
 * the infield and back onto the Wellington Straight.
 */
const SILVERSTONE: CircuitSpec = {
  id: 'silverstone',
  nameKey: 'tracks.silverstone',
  centerline: [
    { x: 14, y: 31 },
    { x: 40, y: 31 },
    { x: 48, y: 28 },
    { x: 51, y: 22 },
    { x: 49, y: 15 },
    { x: 42, y: 8 },
    { x: 28, y: 5 },
    { x: 14, y: 6 },
    { x: 8, y: 10 },
    { x: 6, y: 16 },
    { x: 8, y: 23 },
    { x: 12, y: 28 },
    { x: 14, y: 31 },
  ],
  finish: { x0: 26, x1: 27, y0: 27, y1: 33 },
  startLine: gridSlots(29, 2, [29, 31]),
  arrows: [
    { at: { x: 26.5, y: 26.5 }, dir: { x: 1, y: 0 } },
    { at: { x: 26.5, y: 33.5 }, dir: { x: 1, y: 0 } },
  ],
  checkpoints: [{ x0: 12, y0: 0, x1: 42, y1: 10 }],
};

/**
 * Spa-Francorchamps — clockwise. Vertical start straight on the left heading
 * north into La Source, the Eau Rouge dip, the long Kemmel straight across
 * the top, Les Combes chicane at the top-right, Rivage bulge down the right
 * flank, the Pouhon double-left sweeping to the bottom, Fagnes / Stavelot
 * wiggles and the Bus Stop kink back onto the line. Three colored gates
 * (Kemmel, Rivage, Stavelot) must be taken in order to validate the lap.
 */
const SPA: CircuitSpec = {
  id: 'spa',
  nameKey: 'tracks.spa',
  centerline: [
    { x: 6, y: 26 },
    { x: 6, y: 8 },
    { x: 7.5, y: 4.5 }, // La Source
    { x: 11, y: 4 },
    { x: 14.5, y: 7 }, // Eau Rouge dip
    { x: 18, y: 4 }, // Raidillon crest
    { x: 40, y: 4 }, // Kemmel straight
    { x: 44.5, y: 4.5 }, // Les Combes right-left
    { x: 42, y: 9.5 },
    { x: 47, y: 12 }, // Malmedy
    { x: 50.5, y: 15.5 }, // Rivage
    { x: 50.5, y: 19 },
    { x: 47, y: 23.5 }, // Pouhon double left
    { x: 41.5, y: 28 },
    { x: 36.5, y: 29.5 },
    { x: 32, y: 25.5 }, // Fagnes right-left
    { x: 27.5, y: 29.5 },
    { x: 22, y: 30.5 }, // Stavelot
    { x: 16.5, y: 30.5 },
    { x: 13, y: 31 }, // Bus Stop left-right
    { x: 10.5, y: 27.5 },
    { x: 6, y: 26 },
  ],
  finish: { x0: 4, x1: 8, y0: 20, y1: 21 },
  startLine: gridSlotsVertical(18, -2, [5, 7]),
  arrows: [
    { at: { x: 3.2, y: 20.5 }, dir: { x: 0, y: -1 } },
    { at: { x: 9.8, y: 20.5 }, dir: { x: 0, y: -1 } },
  ],
  checkpoints: [
    { x0: 28, y0: 1, x1: 28, y1: 7, color: '#ef4444' }, // Kemmel
    { x0: 46, y0: 19, x1: 54, y1: 19, color: '#f59e0b' }, // Rivage exit
    { x0: 20, y0: 27, x1: 20, y1: 34, color: '#22c55e' }, // Stavelot
  ],
};

/**
 * Suzuka — reimagined as a Vector-Racer style maze on grid paper: the start
 * straight runs westward along the top, then the corridor snakes through six
 * vertical alleys (two of them with esses) separated by thin walls, climbs
 * the right edge and returns along the top to the line. Six colored gates —
 * one per alley — must be swept in order, so cutting a wall never pays off.
 */
const SUZUKA: CircuitSpec = {
  id: 'suzuka',
  nameKey: 'tracks.suzuka',
  centerline: [
    { x: 26, y: 4 }, // stripe on the top straight, heading west
    { x: 10, y: 4 },
    { x: 5.5, y: 5.5 }, // top-left corner
    { x: 4, y: 9 },
    { x: 4, y: 26 }, // alley 1 down
    { x: 5, y: 29 }, // bottom U-turn
    { x: 8.5, y: 30 },
    { x: 12, y: 29 },
    { x: 13, y: 26 },
    { x: 13, y: 16 }, // alley 2 up
    { x: 14, y: 13 }, // top U-turn
    { x: 17.5, y: 12 },
    { x: 21, y: 13 },
    { x: 22, y: 16 },
    { x: 20.5, y: 20 }, // alley 3: esses down
    { x: 23.5, y: 24 },
    { x: 22, y: 27 },
    { x: 23, y: 29.5 }, // bottom U-turn
    { x: 26.5, y: 30 },
    { x: 30, y: 29 },
    { x: 31, y: 26 },
    { x: 31, y: 16 }, // alley 4 up
    { x: 32, y: 13 }, // top U-turn
    { x: 35.5, y: 12 },
    { x: 39, y: 13 },
    { x: 40, y: 16 },
    { x: 41.5, y: 20 }, // alley 5: esses down
    { x: 38.5, y: 24 },
    { x: 40, y: 27 },
    { x: 41, y: 29.5 }, // bottom U-turn
    { x: 44.5, y: 30 },
    { x: 48, y: 29 },
    { x: 49, y: 26 },
    { x: 49, y: 8 }, // alley 6: right edge all the way up
    { x: 47.5, y: 5 }, // top-right corner
    { x: 44, y: 4 },
    { x: 26, y: 4 }, // back west along the top straight
  ],
  finish: { x0: 26, x1: 27, y0: 2, y1: 6 },
  startLine: gridSlots(24, -2, [3, 5]),
  arrows: [
    { at: { x: 26.5, y: 1.1 }, dir: { x: -1, y: 0 } },
    { at: { x: 26.5, y: 7.6 }, dir: { x: -1, y: 0 } },
  ],
  // Each gate sits at the ENTRY of its alley (relative to race direction),
  // so cutting a wall always lands you past the gate and forces a backtrack.
  checkpoints: [
    { x0: 2, y0: 13, x1: 6, y1: 13, color: '#ef4444' }, // alley 1 (downhill)
    { x0: 11, y0: 24, x1: 15, y1: 24, color: '#ec4899' }, // alley 2 (uphill)
    { x0: 19, y0: 16, x1: 26, y1: 16, color: '#a855f7' }, // alley 3 (downhill)
    { x0: 29, y0: 24, x1: 33, y1: 24, color: '#f59e0b' }, // alley 4 (uphill)
    { x0: 37, y0: 16, x1: 44, y1: 16, color: '#84cc16' }, // alley 5 (downhill)
    { x0: 47, y0: 24, x1: 51, y1: 24, color: '#0ea5e9' }, // alley 6 (uphill)
  ],
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
};

export const TILE_COLORS: Record<TileType, string> = {
  track: PAPER_COLORS.paper,
  grass: PAPER_COLORS.grass,
  finish: PAPER_COLORS.finish,
};
