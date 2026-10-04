/**
 * Situation packet for the Laya decision model.
 *
 * `laya:en` has a 512-token context and that budget includes the questions.
 * A 33×33 window plus a sentence per gear change fills it, Ollaya sets
 * `state_truncated`, and the brain discards the answer. Keep the local map
 * small and each criterion to a few words so the whole decide body fits.
 *
 * The model matches short labels. It does not rank "+1.3" above "-1.0", so
 * every option says what it does in the race: `best`, `with race`, `brake`,
 * `too fast`, `wrong way`, `idle`, `grass`, `back`, or `illegal`. Gear,
 * runway, and the next bend are written beside those words.
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
  segmentCrossesFinish,
  segmentEntersRect,
} from '../../shared/ws-types';
import {
  annotatePath,
  describeTrackSituation,
  segmentGoals,
  sharedPathCache,
  type TrackSituation,
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
 * tokenizer laya:en uses: the heaviest race packet is ~477 tokens
 * (~1320 chars). 1360 chars stays under ~490 tokens, inside the 512
 * window with the [CLS]/marker wrapper still to add.
 */
export const LAYA_REQUEST_CHAR_BUDGET = 1360;

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

/** Below this, a landing has not moved along the racing line. */
const PROGRESS_STEP = 0.05;

function surfaceWord(track: TrackDefinition, x: number, y: number): string {
  const tile = getTileAt(track, x, y);
  if (tile === 'track' || tile === 'finish') return 'asphalt';
  if (tile === 'grass') return 'grass';
  if (tile === 'rumble') return 'rumble';
  return 'void';
}

/**
 * Next three turns if velocity is left unchanged. The first bad surface
 * is named up front so a straight that ends in grass is obvious.
 */
function holdCourse(track: TrackDefinition, position: Vector2D, velocity: Vector2D): string {
  if (velocity.x === 0 && velocity.y === 0) return 'stopped';
  const steps = [1, 2, 3].map((k) => {
    const surface = surfaceWord(track, position.x + k * velocity.x, position.y + k * velocity.y);
    return `${k} ${surface}`;
  });
  const line = steps.join(', ');
  const firstBad = steps.findIndex((step) => !step.endsWith('asphalt'));
  if (firstBad < 0) return line;
  const surface = steps[firstBad]!.split(' ')[1];
  return `leaves ${surface} on ${firstBad + 1}: ${line}`;
}

/** Cells still traveled while shedding gear down to zero, one step per turn. */
function stoppingDistance(gear: number): number {
  return (gear * (gear + 1)) / 2;
}

function aimWord(alignment: string): string {
  if (alignment === 'with_traffic') return 'with';
  if (alignment === 'against') return 'against';
  if (alignment === 'across') return 'across';
  return 'stopped';
}

/** Next bend within a full gear-6 stop. Farther than that is a straight. */
function bendWord(situation: TrackSituation): string {
  const cells = situation.cellsToCorner;
  if (cells == null || cells > 24 || situation.cornerTurn == null) return 'straight';
  return `${situation.cornerTurn} ${cells}`;
}

function forwardScore(
  option: { progress: number; gear: number; clearAhead: number; overspeed: boolean; gate: boolean },
  currentGear: number,
  bendClose: boolean
): number {
  const delta = option.gear - currentGear;
  let score = option.progress * 10;
  if (option.gate) score += 40;
  if (option.overspeed) score -= 60;
  if (option.clearAhead === 0 && option.gear > 0) score -= 30;
  if (option.gear >= 2 && option.clearAhead < option.gear) {
    score -= 6 * (option.gear - option.clearAhead);
  }
  if (option.clearAhead >= 5 && delta > 0 && !option.overspeed && !bendClose) score += 3 * delta;
  if ((option.overspeed || option.clearAhead <= 2 || bendClose) && delta < 0) score += 8;
  if (bendClose && delta >= 0 && currentGear >= 3) score -= 10 * (delta + 1);
  if (option.clearAhead >= 6 && !option.overspeed && !bendClose) score += option.gear;
  return score;
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
  const offTrack =
    player.isOffTrack ||
    getTileAt(track, position.x, position.y) === 'grass' ||
    getTileAt(track, position.x, position.y) === 'rumble';
  const currentGear = gearOf(velocity);
  const stopDist = stoppingDistance(currentGear);
  const bendClose =
    situation.cellsToCorner != null && situation.cellsToCorner <= stopDist + 2;
  const goalIsFinish = passedCheckpoint || !track.checkpoint;
  type Bucket = 'illegal' | 'off' | 'grass' | 'forward' | 'wrong' | 'stop';
  interface PendingOption extends LayaOption {
    bucket: Bucket;
    steps: number;
    progress: number;
    reason: string;
    gear: number;
    clearAhead: number;
    overspeed: boolean;
    gate: boolean;
  }
  const pending: PendingOption[] = [];
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
      const path = onGrid
        ? annotatePath(track, position, next, landing, field)
        : { pathProgress: 0, clearAhead: 0, overspeed: false };
      const pathProgress = path.pathProgress;
      const asphalt = onAsphalt(track, landing.x, landing.y);
      const gate =
        asphalt &&
        (goalIsFinish
          ? segmentCrossesFinish(track, position, landing)
          : segmentEntersRect(position, landing, track.checkpoint!));
      let bucket: Bucket;
      let steps = 0;
      if (illegal) {
        bucket = 'illegal';
      } else if (!asphalt) {
        if (offTrack) {
          // Grass-to-grass pathProgress is 0. Steps to asphalt is the signal.
          bucket = 'off';
          steps = stepsToAsphalt(track, landing.x, landing.y);
        } else {
          // Leaving the circuit. `back` is reserved for a car already off it.
          bucket = 'grass';
        }
      } else if (grass && !offTrack) {
        bucket = 'grass';
      } else if (pathProgress > PROGRESS_STEP) {
        bucket = 'forward';
      } else if (pathProgress < -PROGRESS_STEP) {
        bucket = 'wrong';
      } else {
        bucket = 'stop';
      }
      pending.push({
        label: moveLabel(dx, dy),
        dx,
        dy,
        velocity: next,
        landing,
        illegal,
        detail: '',
        bucket,
        steps,
        progress: pathProgress,
        reason: illegalReason(reasons),
        gear: gearOf(next),
        clearAhead: path.clearAhead,
        overspeed: path.overspeed,
        gate,
      });
    }
  }

  let bestIndex = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  let backIndex = -1;
  let backSteps = Number.POSITIVE_INFINITY;
  pending.forEach((option, index) => {
    if (option.bucket === 'forward') {
      const score = forwardScore(option, currentGear, bendClose);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (option.bucket === 'off' && option.steps < backSteps) {
      backSteps = option.steps;
      backIndex = index;
    }
  });

  const options: LayaOption[] = pending.map((option, index) => {
    const velocityText = `${option.velocity.x},${option.velocity.y}`;
    let detail: string;
    if (option.bucket === 'illegal') detail = `illegal ${option.reason}`;
    else if (option.bucket === 'off') {
      detail = `${index === backIndex ? 'back' : 'away'} ${option.steps} ${velocityText}`;
    } else if (option.bucket === 'grass') detail = 'penalty gear 1';
    else if (option.bucket === 'forward') {
      let head = 'with race';
      if (index === bestIndex) head = 'best';
      else if (option.overspeed || (option.gear >= 3 && option.clearAhead + 1 < option.gear)) {
        head = 'too fast';
      } else if (option.gear < currentGear) head = 'brake';
      const gate = option.gate ? ' gate' : '';
      detail = `${head}${gate} ${velocityText} g${option.gear} r${option.clearAhead}`;
    }     else if (option.bucket === 'wrong') detail = `wrong way ${velocityText}`;
    else detail = `idle ${velocityText}`;
    return {
      label: option.label,
      dx: option.dx,
      dy: option.dy,
      velocity: option.velocity,
      landing: option.landing,
      illegal: option.illegal,
      detail,
    };
  });

  return {
    state: {
      kind: 'vector race',
      dir: `${situation.raceHeading.x},${situation.raceHeading.y}`,
      aim: aimWord(situation.alignment),
      bend: bendWord(situation),
      pace: situation.suggestedMaxGear,
      line: Math.round(situation.lateralOffset),
      stopDist,
      grid: lines.join('\n'),
      vel: `${velocity.x},${velocity.y}`,
      gear: currentGear,
      capped: gearLimited ? 1 : 0,
      goal: goalIsFinish ? 'finish' : 'checkpoint',
      toGoal: situation.cellsToGoal,
      off: offTrack ? stepsToAsphalt(track, position.x, position.y) : 0,
      hold: holdCourse(track, position, velocity),
    },
    options,
  };
}

export const LAYA_MOVE_INSTRUCTIONS =
  'Vector race. Gear max(|vx|,|vy|) carries, max 6. Each option adds -1, 0, or +1 to vx and vy. Shed one gear per turn; brake when bend is inside stopDist. y grows down. dir is the circuit direction. bend, pace, line and aim describe the stretch. hold is the next 3 turns if velocity stays. penalty caps gear at 1 for 3 turns, then 5. Timed mode stops the car. Option: velocity, g gear, r asphalt ahead. Pick best. too fast cannot stop. gate is checkpoint or finish. Grid: . grass, # asphalt, F finish, C checkpoint, @ you, A other, 1/2/3 hold. Never pick penalty, wrong way, idle, or illegal. Off asphalt, pick back.';

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
