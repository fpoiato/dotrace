/**
 * Situation packet for the Laya decision model.
 *
 * `laya:en` has a 512-token context and that budget includes the questions.
 * A 33×33 window plus a sentence per gear change fills it, Ollaya sets
 * `state_truncated`, and the brain discards the answer. Keep the local map
 * small and each criterion to a few words so the whole decide body fits.
 */
import {
  GameState,
  Player,
  TrackDefinition,
  Vector2D,
  gearOf,
  getTileAt,
  isGearLimited,
  isGrassShortcut,
  isValidGearChange,
  landingPosition,
} from '../../shared/ws-types';
import {
  annotatePath,
  describeTrackSituation,
  segmentGoals,
  sharedPathCache,
} from './track-path';

/** laya:en context window, questions included. */
export const LAYA_CONTEXT_TOKENS = 512;

/**
 * Local map radius. 16 (a 33×33 grid) does not fit next to nine criteria.
 * 4 covers the cars that can actually block the next landing.
 */
const WINDOW = 4;

/**
 * Char budget for the JSON decide body. Measured with the ModernBERT
 * tokenizer laya:en uses: a race packet is ~330 tokens (~850 chars).
 * 1050 chars stays under ~400 tokens, inside the 512 window with the
 * [CLS]/marker wrapper still to add.
 */
export const LAYA_REQUEST_CHAR_BUDGET = 1050;

const OPPONENT_LETTERS = 'ABDEFGHIJKLMNPQRSTUVWXYZ';

export interface LayaOption {
  label: string;
  dx: number;
  dy: number;
  velocity: Vector2D;
  landing: Vector2D;
  illegal: boolean;
  detail: string;
}

export interface LayaScene {
  state: Record<string, unknown>;
  options: LayaOption[];
}

export function axisToken(delta: number): string {
  if (delta === -1) return 'm1';
  if (delta === 1) return 'p1';
  return '0';
}

/** Stable choice id for one of the nine gear changes. */
export function moveLabel(dx: number, dy: number): string {
  return `d${axisToken(dx)}_${axisToken(dy)}`;
}

export function parseMoveLabel(label: string): { dx: number; dy: number } | null {
  const match = /^d(m1|0|p1)_(m1|0|p1)$/.exec(label);
  if (!match) return null;
  const decode = (token: string) => (token === 'm1' ? -1 : token === 'p1' ? 1 : 0);
  return { dx: decode(match[1]!), dy: decode(match[2]!) };
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function inCheckpoint(track: TrackDefinition, x: number, y: number): boolean {
  const rect = track.checkpoint;
  if (!rect) return false;
  return x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
}

function terrainChar(track: TrackDefinition, x: number, y: number): string {
  const tile = getTileAt(track, x, y);
  if (tile === null) return ' ';
  if ((tile === 'track' || tile === 'finish') && inCheckpoint(track, x, y)) return 'C';
  if (tile === 'grass') return '.';
  if (tile === 'track') return '#';
  if (tile === 'rumble') return '=';
  if (tile === 'finish') return 'F';
  return '?';
}

function tileName(track: TrackDefinition, x: number, y: number): string {
  return getTileAt(track, x, y) ?? 'void';
}

function onAsphalt(track: TrackDefinition, x: number, y: number): boolean {
  const tile = getTileAt(track, x, y);
  return tile === 'track' || tile === 'finish';
}

/** 8-connected steps to the nearest asphalt cell. 0 when already on it. */
function stepsToAsphalt(track: TrackDefinition, x: number, y: number): number {
  if (onAsphalt(track, x, y)) return 0;
  if (getTileAt(track, x, y) === null) return 99;
  const seen = new Set<string>([cellKey(x, y)]);
  const queue: Array<{ x: number; y: number; d: number }> = [{ x, y, d: 0 }];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.d >= 24) return 24;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        const key = cellKey(nx, ny);
        if (seen.has(key)) continue;
        seen.add(key);
        if (onAsphalt(track, nx, ny)) return cur.d + 1;
        if (getTileAt(track, nx, ny) === null) continue;
        queue.push({ x: nx, y: ny, d: cur.d + 1 });
      }
    }
  }
  return 99;
}

/** One decimal, with a sign. The 1e9 grass-to-asphalt jump is just "back". */
function formatProgress(progress: number): string {
  if (!Number.isFinite(progress) || Math.abs(progress) > 50) return 'back';
  const rounded = Math.round(progress * 10) / 10;
  const text = rounded.toFixed(1);
  return rounded > 0 ? `+${text}` : text;
}

function illegalReason(reasons: string[]): string {
  if (reasons.some((reason) => reason.includes('outside'))) return 'edge';
  if (reasons.some((reason) => reason.includes('another car'))) return 'car';
  return 'gear';
}

export function buildLayaScene(
  player: Player,
  state: GameState,
  track: TrackDefinition
): LayaScene {
  const { position, velocity } = player;
  const gearLimited = isGearLimited(player, state.round);
  const passedCheckpoint = player.passedCheckpoint ?? false;
  const situation = describeTrackSituation(track, position, velocity, passedCheckpoint);
  const goals = segmentGoals(track, passedCheckpoint);
  const field = sharedPathCache.get(track, goals);

  const coast = [1, 2, 3].map((k) => {
    const x = position.x + k * velocity.x;
    const y = position.y + k * velocity.y;
    return { k, x, y, tile: tileName(track, x, y) };
  });

  const opponents = state.players.filter((p) => p.connectionId !== player.connectionId);
  const marks = new Map<string, string>();
  for (const cell of [...coast].reverse()) {
    marks.set(cellKey(cell.x, cell.y), String(cell.k));
  }
  opponents.forEach((opponent, index) => {
    const letter = OPPONENT_LETTERS[index] ?? '?';
    marks.set(cellKey(opponent.position.x, opponent.position.y), letter);
  });
  marks.set(cellKey(position.x, position.y), '@');

  const lines: string[] = [];
  for (let y = position.y - WINDOW; y <= position.y + WINDOW; y++) {
    let row = '';
    for (let x = position.x - WINDOW; x <= position.x + WINDOW; x++) {
      row += marks.get(cellKey(x, y)) ?? terrainChar(track, x, y);
    }
    lines.push(row);
  }

  const occupied = new Set(opponents.map((p) => cellKey(p.position.x, p.position.y)));
  const options: LayaOption[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const next: Vector2D = { x: velocity.x + dx, y: velocity.y + dy };
      const landing = landingPosition(position, next);
      const reasons: string[] = [];
      if (!isValidGearChange(velocity, next, gearLimited)) {
        reasons.push(gearLimited ? 'gear limited to 1' : 'gear above 6 or illegal change');
      }
      if (getTileAt(track, landing.x, landing.y) === null) {
        reasons.push('lands outside the grid');
      }
      if (occupied.has(cellKey(landing.x, landing.y))) {
        reasons.push('lands on another car');
      }
      const illegal = reasons.length > 0;
      const onGrid = getTileAt(track, landing.x, landing.y) !== null;
      const grass = onGrid && isGrassShortcut(track, position, landing);
      const pathProgress = onGrid
        ? annotatePath(track, position, next, landing, field).pathProgress
        : 0;
      const asphalt = onAsphalt(track, landing.x, landing.y);
      let detail: string;
      if (illegal) {
        detail = `illegal ${illegalReason(reasons)}`;
      } else if (!asphalt) {
        // Grass-to-grass pathProgress is 0, so the useful signal is how
        // many steps this landing is from the track.
        detail = `grass away ${stepsToAsphalt(track, landing.x, landing.y)}`;
      } else if (grass) {
        detail = `grass ${formatProgress(pathProgress)}`;
      } else {
        const name = getTileAt(track, landing.x, landing.y) === 'finish' ? 'finish' : 'asphalt';
        detail = `${name} ${formatProgress(pathProgress)}`;
      }
      options.push({
        label: moveLabel(dx, dy),
        dx,
        dy,
        velocity: next,
        landing,
        illegal,
        detail,
      });
    }
  }

  const offTrack =
    player.isOffTrack ||
    getTileAt(track, position.x, position.y) === 'grass' ||
    getTileAt(track, position.x, position.y) === 'rumble';

  return {
    state: {
      grid: lines.join('\n'),
      vel: `${velocity.x},${velocity.y}`,
      gear: gearOf(velocity),
      capped: gearLimited ? 1 : 0,
      goal: passedCheckpoint || !track.checkpoint ? 'finish' : 'checkpoint',
      toGoal: situation.cellsToGoal,
      corner: situation.cellsToCorner,
      off: offTrack ? stepsToAsphalt(track, position.x, position.y) : 0,
      coast,
    },
    options,
  };
}

export const LAYA_MOVE_INSTRUCTIONS =
  'Grid: . grass, # asphalt, F finish, C checkpoint, @ you, A other, 1/2/3 coast. y grows downward. Pick the highest legal asphalt or finish progress. Reject illegal. Avoid grass. Off the track, pick the lowest away.';

/** JSON body posted to Ollaya `/api/decide`. */
export function layaDecideBody(scene: LayaScene, model: string) {
  return {
    model,
    state: scene.state,
    questions: {
      move: {
        type: 'choice' as const,
        instructions: LAYA_MOVE_INSTRUCTIONS,
        criteria: Object.fromEntries(scene.options.map((option) => [option.label, option.detail])),
      },
    },
    keep_alive: '-1',
  };
}
