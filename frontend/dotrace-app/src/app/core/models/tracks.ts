import { TileType, TrackArrow, TrackDefinition, Vector2D } from './ws-types';

/**
 * Circuits are rasterized from a centerline polyline stamped with a round
 * brush, mimicking a marker pen on grid paper. Layouts approximate the
 * classic outlines of Monza, Monaco, Interlagos, Spa-Francorchamps,
 * Silverstone and Suzuka.
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

interface CircuitSpec {
  id: string;
  nameKey: string;
  centerline: Vector2D[];
  finish: { x0: number; x1: number; y0: number; y1: number };
  startLine: Vector2D[];
  arrows: TrackArrow[];
  checkpoint: { x0: number; y0: number; x1: number; y1: number };
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
  checkpoint: { x0: 3, y0: 1, x1: 20, y1: 12 },
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
  checkpoint: { x0: 42, y0: 4, x1: 54, y1: 18 },
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
  checkpoint: { x0: 44, y0: 12, x1: 54, y1: 28 },
};

/**
 * Spa-Francorchamps — clockwise: long start/finish straight along the bottom,
 * La Source hairpin into the valley, Eau Rouge/Raidillon climb up to the
 * Ardennes plateau, Pouhon left-hander, Stavelot and Bus Stop chicane back
 * down to the start straight.
 */
const SPA: CircuitSpec = {
  id: 'spa',
  nameKey: 'tracks.spa',
  centerline: [
    { x: 10, y: 28 },
    { x: 44, y: 28 },
    { x: 50, y: 22 },
    { x: 48, y: 14 },
    { x: 42, y: 8 },
    { x: 28, y: 5 },
    { x: 14, y: 8 },
    { x: 6, y: 16 },
    { x: 8, y: 24 },
    { x: 10, y: 28 },
  ],
  finish: { x0: 12, x1: 13, y0: 25, y1: 31 },
  startLine: gridSlots(15, 2, [27, 29]),
  arrows: [
    { at: { x: 12.5, y: 23.5 }, dir: { x: 1, y: 0 } },
    { at: { x: 12.5, y: 32.5 }, dir: { x: 1, y: 0 } },
  ],
  checkpoint: { x0: 26, y0: 2, x1: 54, y1: 16 },
};

/**
 * Silverstone — clockwise: start/finish straight along the bottom, fast
 * sweeper through Copse, Maggotts-Becketts-Chapel esses across the top,
 * Stowe and Club corners returning down the left side.
 */
const SILVERSTONE: CircuitSpec = {
  id: 'silverstone',
  nameKey: 'tracks.silverstone',
  centerline: [
    { x: 12, y: 31 },
    { x: 42, y: 31 },
    { x: 50, y: 25 },
    { x: 52, y: 17 },
    { x: 46, y: 8 },
    { x: 34, y: 4 },
    { x: 20, y: 4 },
    { x: 8, y: 10 },
    { x: 6, y: 20 },
    { x: 10, y: 29 },
    { x: 12, y: 31 },
  ],
  finish: { x0: 14, x1: 15, y0: 28, y1: 34 },
  startLine: gridSlots(17, 2, [30, 32]),
  arrows: [
    { at: { x: 14.5, y: 26.5 }, dir: { x: 1, y: 0 } },
    { at: { x: 14.5, y: 35.5 }, dir: { x: 1, y: 0 } },
  ],
  checkpoint: { x0: 38, y0: 2, x1: 55, y1: 20 },
};

/**
 * Suzuka — clockwise: start/finish straight along the bottom-centre,
 * sweeping right side through the esses, tight hairpin at the top-right,
 * Spoon curve, sweeping 130R left-hander down the left, chicane back
 * onto the start straight.
 */
const SUZUKA: CircuitSpec = {
  id: 'suzuka',
  nameKey: 'tracks.suzuka',
  centerline: [
    { x: 28, y: 32 },
    { x: 44, y: 32 },
    { x: 50, y: 26 },
    { x: 52, y: 18 },
    { x: 48, y: 10 },
    { x: 38, y: 5 },
    { x: 26, y: 5 },
    { x: 16, y: 8 },
    { x: 8, y: 16 },
    { x: 8, y: 26 },
    { x: 18, y: 32 },
    { x: 28, y: 32 },
  ],
  finish: { x0: 22, x1: 23, y0: 29, y1: 35 },
  startLine: gridSlots(25, 1, [31, 33]),
  arrows: [
    { at: { x: 22.5, y: 27.5 }, dir: { x: 1, y: 0 } },
    { at: { x: 22.5, y: 35.5 }, dir: { x: 1, y: 0 } },
  ],
  checkpoint: { x0: 40, y0: 3, x1: 55, y1: 18 },
};

export const TRACKS: TrackDefinition[] = [
  buildCircuit(MONZA),
  buildCircuit(MONACO),
  buildCircuit(INTERLAGOS),
  buildCircuit(SPA),
  buildCircuit(SILVERSTONE),
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
