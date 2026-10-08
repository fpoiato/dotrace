/**
 * Situation packet for the Laya decision model.
 *
 * Dot Race asks `laya:typed-decisions` (ModernBERT-large, English, 1024
 * tokens, questions included). The router name `laya` still sends English to
 * `laya:en`, whose window is 512. A 33×33 window plus a sentence per gear
 * change used to fill that smaller window; Ollaya then sets `state_truncated`
 * and the brain discards the answer. The map is only the road ahead of
 * the car, including the next three landings if velocity stays. Each
 * criterion stays a few words.
 *
 * The model matches short labels. It does not rank "+1.3" above "-1.0", so
 * every option says what it does in the race: `best`, `with race`, `brake`,
 * `too fast`, `wrong way`, `idle`, `penalty`, `back`, or `illegal`. Gear,
 * runway, and the next bend are written beside those words.
 */
import {
  GameState,
  Player,
  TrackDefinition,
  Vector2D,
  gearOf,
  getTileAt,
  isDrsAsphalt,
  isGearLimited,
  isGrassShortcut,
  isStrictlyAhead,
  isValidGearChange,
  landingPosition,
  segmentCrossesFinish,
  segmentEntersRect,
} from '../../shared/ws-types';
import { adviseBoost, type BoostPick } from './boost-advice';
import {
  annotatePath,
  densifyRacingLine,
  describeTrackSituation,
  racingLine,
  segmentGoals,
  sharedPathCache,
  type TrackSituation,
} from './track-path';

/**
 * `laya:typed-decisions` context, questions included. Same ModernBERT-large
 * weights as `laya:en` (512); this tag is the 1024-token fine-tune.
 */
export const LAYA_CONTEXT_TOKENS = 1024;

/** Tag posted to `/api/decide`. The router `laya` does not select this model. */
export const LAYA_DECIDE_MODEL = 'laya:typed-decisions';

/**
 * Cells of track drawn beside the path. The map does not extend behind
 * the car: a square window spent half of its tokens on road already passed,
 * and at gear 6 the next three landings sat outside it.
 */
const SIDE = 4;

/** Road drawn ahead when the car is slow or stopped. */
const AHEAD = 14;

const HOLD_TURNS = 3;

/**
 * Char budget for the JSON decide body. Measured with the ModernBERT
 * tokenizer: the heaviest forward map (gear 6 on a diagonal) is ~546
 * tokens (~1860 chars) before the boost question. 2800 chars stays under
 * ~850 tokens, inside the 1024 window with the [CLS]/marker wrapper.
 */
export const LAYA_REQUEST_CHAR_BUDGET = 2800;

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
  if (tile === 'track' && isDrsAsphalt(track, x, y)) return 'B';
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
 * One cell along the dominant axes. A shallow heading stays on one axis
 * so the map does not open a diagonal box for a nearly straight road.
 */
function dominantStep(heading: { x: number; y: number }): Vector2D {
  const x = Math.abs(heading.x) < 0.35 ? 0 : heading.x > 0 ? 1 : -1;
  const y = Math.abs(heading.y) < 0.35 ? 0 : heading.y > 0 ? 1 : -1;
  if (x === 0 && y === 0) return { x: heading.x >= 0 ? 1 : -1, y: 0 };
  return { x, y };
}

/**
 * Rectangle from the car forward along travel (the circuit, when stopped).
 * Cells behind the car are left out. The box always covers the next three
 * held-velocity landings, and at least AHEAD cells of road in front.
 */
function forwardSpan(
  position: Vector2D,
  velocity: Vector2D,
  raceHeading: { x: number; y: number }
): { x0: number; y0: number; x1: number; y1: number } {
  const moving = velocity.x !== 0 || velocity.y !== 0;
  const step = moving ? velocity : dominantStep(raceHeading);
  const samples: Vector2D[] = [{ x: position.x, y: position.y }];
  if (moving) {
    for (let k = 1; k <= HOLD_TURNS; k++) {
      samples.push({
        x: position.x + k * velocity.x,
        y: position.y + k * velocity.y,
      });
    }
  }
  const cheb = Math.max(Math.abs(step.x), Math.abs(step.y)) || 1;
  const reach = moving
    ? Math.max(AHEAD, HOLD_TURNS * Math.max(Math.abs(velocity.x), Math.abs(velocity.y)))
    : AHEAD;
  for (let k = 1; k <= reach; k++) {
    samples.push({
      x: position.x + Math.round((k * step.x) / cheb),
      y: position.y + Math.round((k * step.y) / cheb),
    });
  }

  let x0 = Math.min(...samples.map((p) => p.x)) - SIDE;
  let x1 = Math.max(...samples.map((p) => p.x)) + SIDE;
  let y0 = Math.min(...samples.map((p) => p.y)) - SIDE;
  let y1 = Math.max(...samples.map((p) => p.y)) + SIDE;
  if (step.x > 0) x0 = position.x;
  else if (step.x < 0) x1 = position.x;
  if (step.y > 0) y0 = position.y;
  else if (step.y < 0) y1 = position.y;
  return { x0, y0, x1, y1 };
}

/**
 * Next three turns if velocity is left unchanged. Each step names the cell
 * and the surface. The first bad surface is named up front.
 */
function holdCourse(track: TrackDefinition, position: Vector2D, velocity: Vector2D): string {
  if (velocity.x === 0 && velocity.y === 0) return 'stopped';
  const steps = [1, 2, 3].map((k) => {
    const x = position.x + k * velocity.x;
    const y = position.y + k * velocity.y;
    return `${k} ${x},${y} ${surfaceWord(track, x, y)}`;
  });
  const line = steps.join(', ');
  const firstBad = steps.findIndex((step) => !step.endsWith('asphalt'));
  if (firstBad < 0) return line;
  const surface = steps[firstBad]!.split(' ').pop();
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

/** Highest gear whose stopping distance fits in the runway ahead. */
function paceForStretch(cellsToCorner: number | null): number {
  const runway = cellsToCorner == null || cellsToCorner > 24 ? 28 : cellsToCorner;
  for (let gear = 6; gear >= 1; gear--) {
    if ((gear * (gear + 1)) / 2 <= runway) return gear;
  }
  return 1;
}

function steerSin(
  velocity: Vector2D,
  heading: { x: number; y: number }
): { align: number; cross: number } {
  const hLen = Math.hypot(heading.x, heading.y) || 1;
  const vLen = Math.hypot(velocity.x, velocity.y) || 1;
  return {
    align: (heading.x * velocity.x + heading.y * velocity.y) / (hLen * vLen),
    cross: (heading.x * velocity.y - heading.y * velocity.x) / (hLen * vLen),
  };
}

/** Sideways step off the circuit, or away from a bend that is already close. */
function isDrift(
  velocity: Vector2D,
  heading: { x: number; y: number },
  cornerTurn: TrackSituation['cornerTurn'],
  bendClose: boolean
): boolean {
  const { cross } = steerSin(velocity, heading);
  if (Math.abs(cross) < 0.25) return false;
  if (!bendClose || cornerTurn == null || cornerTurn === 'hairpin') return Math.abs(cross) >= 0.35;
  const toward = cornerTurn === 'right' ? -cross : cross;
  return toward < -0.2;
}

const lineCache = new Map<string, Vector2D[]>();

/** Chebyshev distance from a cell to the racing line. The corridor is ~7 wide. */
function lineOffset(track: TrackDefinition, point: Vector2D): number {
  let line = lineCache.get(track.id);
  if (!line) {
    line = densifyRacingLine(racingLine(track), 1);
    lineCache.set(track.id, line);
  }
  let best = Number.POSITIVE_INFINITY;
  let nearest = point;
  for (const sample of line) {
    const d = (sample.x - point.x) ** 2 + (sample.y - point.y) ** 2;
    if (d < best) {
      best = d;
      nearest = sample;
    }
  }
  return Math.max(Math.abs(nearest.x - point.x), Math.abs(nearest.y - point.y));
}

/** Heading of the racing line a few cells in front of the car. */
function headingAhead(track: TrackDefinition, point: Vector2D, cells: number): Vector2D {
  let line = lineCache.get(track.id);
  if (!line) {
    line = densifyRacingLine(racingLine(track), 1);
    lineCache.set(track.id, line);
  }
  if (line.length === 0) return { x: 1, y: 0 };
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < line.length; i++) {
    const sample = line[i]!;
    const d = (sample.x - point.x) ** 2 + (sample.y - point.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const at = (best + Math.max(1, Math.round(cells))) % line.length;
  const a = line[at]!;
  const b = line[(at + 1) % line.length]!;
  return { x: b.x - a.x, y: b.y - a.y };
}

/**
 * Racing score for one asphalt step.
 *
 * The car is aimed at the racing line a few cells ahead, so a bend starts
 * while there is still room to rotate. Speed stays up while that aim lines
 * up and the asphalt holds. Braking is for a step that is still pointing
 * down the straight, or that runs out of road. Crossing the gate stays a
 * valid step even when the landing is past the stripe.
 */
function forwardScore(
  option: {
    progress: number;
    gear: number;
    clearAhead: number;
    overspeed: boolean;
    gate: boolean;
    velocity: Vector2D;
    lateral: number;
  },
  currentGear: number,
  currentLateral: number,
  situation: TrackSituation,
  targetHeading: Vector2D
): number {
  const { align, cross } = steerSin(option.velocity, targetHeading);
  const delta = option.gear - currentGear;
  const edge = Math.max(0, option.lateral - 3);
  const cells = situation.cellsToCorner ?? 99;
  const misaligned = align < 0.75;
  const bendSoon = cells <= 8;

  let score = option.gate ? 0 : option.progress * 8;
  if (option.gate) score += 400;
  if (option.overspeed) score -= 140;
  if (option.clearAhead === 0 && option.gear > 0) score -= 100;
  else if (option.clearAhead <= 1 && option.gear >= 3) score -= 50;
  else if (option.clearAhead <= 2 && option.gear >= 5) score -= 25;

  score += align * 24;
  score -= Math.abs(cross) * 28;
  score -= edge * 14;
  if (option.lateral > currentLateral) {
    score -= (option.lateral - currentLateral) * 16;
  }

  const roadOk = !option.overspeed && option.clearAhead >= 2 && option.lateral <= 3 && !misaligned;
  if (roadOk && delta > 0) score += 18 * delta;
  if (roadOk) score += option.gear * 4;
  if (roadOk && delta < 0) score -= 14 * -delta;
  if (misaligned && bendSoon && delta >= 0 && currentGear >= 3) score -= 20 * (delta + 1);
  if (misaligned && bendSoon && delta < 0 && align > 0.35) score += 12;
  return score;
}

/** Squares to the nearest rival ahead. Lead when this car is the first. */
function rivalGap(player: Player, state: GameState, track: TrackDefinition): number | 'lead' {
  let best = Number.POSITIVE_INFINITY;
  for (const opponent of state.players) {
    if (opponent.connectionId === player.connectionId) continue;
    if (opponent.finishOrder !== undefined) continue;
    if (!isStrictlyAhead(opponent, player, track)) continue;
    const gap = Math.max(
      Math.abs(opponent.position.x - player.position.x),
      Math.abs(opponent.position.y - player.position.y)
    );
    if (gap < best) best = gap;
  }
  return Number.isFinite(best) ? best : 'lead';
}

/** Blue cells under the car and ahead, one step at a time, until the zone ends. */
function blueAhead(track: TrackDefinition, position: Vector2D, velocity: Vector2D): number {
  const sx = Math.sign(velocity.x);
  const sy = Math.sign(velocity.y);
  let n = 0;
  for (let k = 0; k <= 8; k++) {
    const x = position.x + k * sx;
    const y = position.y + k * sy;
    if (!isDrsAsphalt(track, x, y)) {
      if (k === 0) continue;
      break;
    }
    n++;
  }
  return n;
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

  const span = forwardSpan(position, velocity, situation.raceHeading);
  const lines: string[] = [];
  for (let y = span.y0; y <= span.y1; y++) {
    let row = '';
    for (let x = span.x0; x <= span.x1; x++) {
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
  const currentLateral = lineOffset(track, position);
  const bendClose =
    situation.cellsToCorner != null && situation.cellsToCorner < stopDist;
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
      } else if (
        pathProgress > PROGRESS_STEP ||
        (gate && steerSin(next, situation.raceHeading).align > 0.35)
      ) {
        // Jumping the stripe wraps the distance field negative. It is still
        // the lap when the car is aimed with the circuit.
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

  const look = Math.min(6, situation.cellsToCorner ?? 6);
  const targetHeading = headingAhead(track, position, look);
  let bestIndex = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  let backIndex = -1;
  let backSteps = Number.POSITIVE_INFINITY;
  pending.forEach((option, index) => {
    if (option.bucket === 'forward') {
      const score = forwardScore(
        {
          progress: option.progress,
          gear: option.gear,
          clearAhead: option.clearAhead,
          overspeed: option.overspeed,
          gate: option.gate,
          velocity: option.velocity,
          lateral: lineOffset(track, option.landing),
        },
        currentGear,
        currentLateral,
        situation,
        targetHeading
      );
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
      const drift = isDrift(
        option.velocity,
        situation.raceHeading,
        situation.cornerTurn,
        bendClose
      );
      const cannotStop =
        situation.cellsToCorner != null &&
        stoppingDistance(option.gear) > situation.cellsToCorner;
      if (index === bestIndex) head = 'best';
      else if (drift) head = 'drift';
      else if (
        option.overspeed ||
        cannotStop ||
        (option.gear >= 3 && option.clearAhead + 1 < option.gear)
      ) {
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

  const best = bestIndex >= 0 ? pending[bestIndex] : undefined;
  const gap = rivalGap(player, state, track);
  const blue = blueAhead(track, position, velocity);
  const drs = player.drsActive ? 'open' : player.drsArmed ? 'armed' : 'shut';
  const boost: BoostPick = best
    ? adviseBoost({
        gear: currentGear,
        nextGear: best.gear,
        clearAhead: best.clearAhead,
        overspeed: best.overspeed,
        gearLimited,
        drsArmed: !!player.drsArmed,
        drsActive: !!player.drsActive,
        ersCharge: player.ersCharge ?? 0,
        gap,
        blue,
        bendCells: situation.cellsToCorner,
        fuel: player.fuel,
        pit: false,
      })
    : 'save';

  return {
    state: {
      kind: 'vector race',
      dir: `${situation.raceHeading.x},${situation.raceHeading.y}`,
      aim: aimWord(situation.alignment),
      bend: bendWord(situation),
      pace: paceForStretch(situation.cellsToCorner),
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
      drs,
      ers: player.ersCharge ?? 0,
      gap,
      blue,
      boost,
      ...(player.fuel !== undefined ? { fuel: Math.round(player.fuel) } : {}),
    },
    options,
  };
}

export const LAYA_MOVE_INSTRUCTIONS =
  'Vector race. Gear max(|vx|,|vy|) carries, max 6, or 8 with DRS open. Each option adds -1, 0, or +1 to vx and vy. Accelerate up to pace when bend is straight and hold stays on asphalt. Slow down only when bend is inside stopDist. y grows down. dir is the circuit direction. Steer with dir. bend, pace, line and aim describe the stretch. hold is the next 3 turns if velocity stays. penalty caps gear at 1 for 3 turns, then 5. Timed mode stops the car. Option: velocity, g gear, r asphalt ahead. Pick best. too fast cannot stop. gate is checkpoint or finish. Grid is only the road ahead of @. . grass, # asphalt, B blue DRS, F finish, C checkpoint, @ you, A other. 1/2/3 are those same 3 turns. Nothing behind @ is drawn. Never pick penalty, wrong way, idle, or illegal. Off asphalt, pick back.';

export const LAYA_BOOST_INSTRUCTIONS =
  'Pick state.boost. DRS arms only on B with a rival within 6 (gap). Open wing allows gear 8 and a +2 climb below gear 6, then closes if you brake or leave B. ers is bars left of 4; one bar is a +2 step and half fuel. save when braking, bend is inside stopDist, gap is lead, or blue is short. drs on a long blue straight. ers only for a +2 the wing cannot give. both only at gear 6, gap<=4, blue>=4.';

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
      boost: {
        type: 'choice' as const,
        instructions: LAYA_BOOST_INSTRUCTIONS,
        criteria: {
          save: 'keep wing shut and battery',
          drs: 'open wing, do not spend a bar',
          ers: 'spend 1 bar, wing stays shut',
          both: 'open wing and spend 1 bar',
        },
      },
    },
    keep_alive: '-1',
  };
}
