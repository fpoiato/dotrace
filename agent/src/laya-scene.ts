/**
 * Situation packet for the Laya decision model.
 *
 * The full circuit does not fit laya:en's context, so the state carries a
 * window around the car, every pilot, and the three cells this car would
 * reach if velocity stayed constant. The nine gear changes are the choice
 * criteria; each one already says whether that change is illegal or cuts grass.
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

const WINDOW = 16;

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
      const status = illegal ? `illegal (${reasons.join('; ')})` : 'legal';
      const grassNote = grass ? '; grass penalty' : '';
      options.push({
        label: moveLabel(dx, dy),
        dx,
        dy,
        velocity: next,
        landing,
        illegal,
        detail:
          `accel (${dx},${dy}) -> velocity (${next.x},${next.y}) ` +
          `lands (${landing.x},${landing.y}) on ${tileName(track, landing.x, landing.y)}; ` +
          `${status}${grassNote}; pathProgress ${pathProgress.toFixed(2)}`,
      });
    }
  }

  return {
    state: {
      legend:
        '. grass, # asphalt, = rumble, F finish, C checkpoint, @ you, A/B/… other pilots, 1/2/3 where you will be in 1/2/3 rounds if velocity stays constant. y grows downward.',
      grid: lines.join('\n'),
      round: state.round,
      lap: player.lap,
      totalLaps: state.totalLaps,
      mode: state.gameMode,
      goal: passedCheckpoint || !track.checkpoint ? 'finish' : 'checkpoint',
      lapProgressPct: situation.lapProgressPct,
      cellsToGoal: situation.cellsToGoal,
      me: {
        position,
        velocity,
        gear: gearOf(velocity),
        passedCheckpoint,
      },
      coast,
      pilots: state.players.map((p) => ({
        nickname: p.nickname,
        self: p.connectionId === player.connectionId,
        position: p.position,
        velocity: p.velocity,
        gear: gearOf(p.velocity),
        lap: p.lap,
        passedCheckpoint: p.passedCheckpoint ?? false,
        finished: p.finishOrder !== undefined,
      })),
    },
    options,
  };
}

export const LAYA_MOVE_INSTRUCTIONS =
  'Choose the gear change that stays on the asphalt, does not land on another car, and reaches the checkpoint and then the finish in the fewest rounds. Reject any option marked illegal. Avoid grass.';
