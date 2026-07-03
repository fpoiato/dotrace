import { TileType, TrackDefinition, Vector2D } from './ws-types';

function emptyGrid(w: number, h: number, fill: TileType = 'grass'): TileType[][] {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => fill));
}

function carveRect(
  grid: TileType[][],
  x: number,
  y: number,
  w: number,
  h: number,
  tile: TileType = 'track'
): void {
  for (let row = y; row < y + h && row < grid.length; row++) {
    for (let col = x; col < x + w && col < grid[0].length; col++) {
      grid[row][col] = tile;
    }
  }
}

function carvePath(grid: TileType[][], points: Vector2D[], width = 1): void {
  for (const p of points) {
    for (let dy = 0; dy < width; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const y = p.y + dy;
        const x = p.x + dx;
        if (y >= 0 && y < grid.length && x >= 0 && x < grid[0].length) {
          grid[y][x] = 'track';
        }
      }
    }
  }
}

/** Monza-inspired oval with chicane (32×24). */
function buildMonza(): TrackDefinition {
  const w = 32;
  const h = 24;
  const grid = emptyGrid(w, h);
  const path: Vector2D[] = [];
  for (let x = 4; x <= 27; x++) path.push({ x, y: 4 });
  for (let y = 4; y <= 19; y++) path.push({ x: 27, y });
  for (let x = 27; x >= 4; x--) path.push({ x, y: 19 });
  for (let y = 19; y >= 4; y--) path.push({ x: 4, y });
  carvePath(grid, path, 2);
  carveRect(grid, 12, 3, 4, 3, 'finish');
  const startLine: Vector2D[] = [
    { x: 6, y: 5 },
    { x: 8, y: 5 },
    { x: 10, y: 5 },
    { x: 12, y: 5 },
  ];
  return {
    id: 'monza',
    nameKey: 'tracks.monza',
    width: w,
    height: h,
    grid,
    startLine,
  };
}

/** Monaco-inspired tight street circuit (28×32). */
function buildMonaco(): TrackDefinition {
  const w = 28;
  const h = 32;
  const grid = emptyGrid(w, h);
  const path: Vector2D[] = [];
  for (let x = 3; x <= 24; x++) path.push({ x, y: 3 });
  for (let y = 3; y <= 10; y++) path.push({ x: 24, y });
  for (let x = 24; x >= 14; x--) path.push({ x, y: 10 });
  for (let y = 10; y <= 22; y++) path.push({ x: 14, y });
  for (let x = 14; x <= 24; x++) path.push({ x, y: 22 });
  for (let y = 22; y <= 28; y++) path.push({ x: 24, y });
  for (let x = 24; x >= 3; x--) path.push({ x, y: 28 });
  for (let y = 28; y >= 3; y--) path.push({ x: 3, y });
  carvePath(grid, path, 2);
  carveRect(grid, 20, 2, 4, 2, 'finish');
  const startLine: Vector2D[] = [
    { x: 5, y: 4 },
    { x: 7, y: 4 },
    { x: 9, y: 4 },
    { x: 11, y: 4 },
  ];
  return {
    id: 'monaco',
    nameKey: 'tracks.monaco',
    width: w,
    height: h,
    grid,
    startLine,
  };
}

/** Interlagos-inspired figure-eight-ish layout (30×26). */
function buildInterlagos(): TrackDefinition {
  const w = 30;
  const h = 26;
  const grid = emptyGrid(w, h);
  const path: Vector2D[] = [];
  for (let x = 4; x <= 25; x++) path.push({ x, y: 5 });
  for (let y = 5; y <= 12; y++) path.push({ x: 25, y });
  for (let x = 25; x >= 15; x--) path.push({ x, y: 12 });
  for (let y = 12; y <= 20; y++) path.push({ x: 15, y });
  for (let x = 15; x <= 25; x++) path.push({ x, y: 20 });
  for (let y = 20; y >= 5; y--) path.push({ x: 4, y });
  carvePath(grid, path, 2);
  carveRect(grid, 22, 4, 3, 2, 'finish');
  const startLine: Vector2D[] = [
    { x: 6, y: 6 },
    { x: 8, y: 6 },
    { x: 10, y: 6 },
    { x: 12, y: 6 },
  ];
  return {
    id: 'interlagos',
    nameKey: 'tracks.interlagos',
    width: w,
    height: h,
    grid,
    startLine,
  };
}

export const TRACKS: TrackDefinition[] = [buildMonza(), buildMonaco(), buildInterlagos()];

export function getTrackById(id: string): TrackDefinition | undefined {
  return TRACKS.find((t) => t.id === id);
}

export const TILE_COLORS: Record<TileType, string> = {
  track: '#374151',
  grass: '#166534',
  finish: '#FBBF24',
};

export const TILE_COLORS_DARK: Record<TileType, string> = {
  track: '#1F2937',
  grass: '#14532D',
  finish: '#F59E0B',
};
