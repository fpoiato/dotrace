/**
 * Shared WebSocket contract for "Dot Race" (Vector Rally).
 * Mirror into frontend/dotrace-app/src/app/core/models/ws-types.ts.
 *
 * Game state is ephemeral and HOST-AUTHORITATIVE.
 */

export type PlayerStatus = 'pending' | 'approved';

export interface Vector2D {
  x: number;
  y: number;
}

export type TileType = 'track' | 'grass' | 'finish' | 'rumble' | 'pit' | 'pitbox';

export interface CheckpointRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TrackArrow {
  at: Vector2D;
  dir: Vector2D;
}

export interface TrackDefinition {
  id: string;
  nameKey: string;
  width: number;
  height: number;
  grid: TileType[][];
  startLine: Vector2D[];
  /** Race-direction arrows drawn next to the start stripe. */
  arrows: TrackArrow[];
  /**
   * Directed racing line (closed polyline; last point equals first). Used by
   * the AI pilot for corridor progress — BFS alone would take the short wrong
   * way around a loop.
   */
  centerline: Vector2D[];
  /**
   * Zone (usually the far side of the circuit) a car must have visited before
   * landing on the finish stripe counts as completing the lap. Prevents
   * "finishing" by reversing over the line on turn one.
   */
  checkpoint?: CheckpointRect;
  /**
   * Authoring boxes for the DRS strips, separate from the lap checkpoint.
   * The blue area is the asphalt between the two cuts where the centerline
   * enters and leaves the box. Each cut is perpendicular to the track sides.
   */
  drsZones?: CheckpointRect[];
  /**
   * Pit stalls on the detour beside the longest straight, in grid order.
   * Index matches the car's start-line slot (pitBoxIndex).
   */
  pitBoxes?: Vector2D[];
}

export interface Player {
  connectionId: string;
  nickname: string;
  color: string;
  isHost: boolean;
  joinOrder: number;
  status: PlayerStatus;
  position: Vector2D;
  velocity: Vector2D;
  isOffTrack: boolean;
  /** Move history (pen trail on the paper), reset at every completed lap. */
  trail: Vector2D[];
  /** Current lap, 1-based. */
  lap: number;
  /** Set once the car has passed the far-side checkpoint (lap validity gate). */
  passedCheckpoint?: boolean;
  diceRoll?: number;
  finishOrder?: number;
  /** Wall-clock finish time (epoch ms). Set when the player completes the race. */
  finishedAt?: number;
  /** Racing round when the player finished (turn-based race time). */
  finishRound?: number;
  /**
   * Epoch ms timestamp recorded at each lap completion (index 0 = lap 1).
   * Length equals laps completed; grows to totalLaps when the player finishes.
   */
  lapTimes?: number[];
  /**
   * Round number recorded at each lap completion (index 0 = lap 1).
   * Meaningful in TURNS mode; mirrors lapTimes but in round units.
   */
  lapRounds?: number[];
  /** Grass shortcuts taken this race (drives escalating penalties). */
  grassCuts?: number;
  /** TURNS mode: max gear 1 until this round (inclusive). */
  gearPenaltyUntilRound?: number;
  /** TIMED mode: epoch ms before the player may move again. */
  stopUntil?: number;
  /** DRS button may be pressed (armed by a detection zone this lap). */
  drsArmed?: boolean;
  /** DRS is open: this move's gear ceiling is 7 until the gear falls. */
  drsActive?: boolean;
  /** Indexes into the track's drsZones already spent this lap. */
  drsZonesUsed?: number[];
  /** ERS battery, 0–4 in steps of 0.25. One full bar spent opens delta 2. */
  ersCharge?: number;
  /** Last accepted move spent an ERS bar. Cleared on this car's next move. */
  ersActive?: boolean;
  /** Remaining fuel. Undefined when the race is 5 laps or shorter. */
  fuel?: number;
  /** Start-line slot; selects this car's colored pit stall. */
  pitBoxIndex?: number;
  /** In pit lane with a drive-through still to serve. Cleared on exit or a stop. */
  driveThroughArmed?: boolean;
  /** Drive-throughs still owed (one per 3 black-and-white flags). */
  driveThroughOwed?: number;
  /** Inclusive round the car must sit still after stopping in its own box. */
  pitHoldUntilRound?: number;
  /** Finished the race without serving a required drive-through. */
  disqualified?: boolean;
}

export type GamePhase = 'LOBBY' | 'GRID_ORDER' | 'GAME_ROUND' | 'GAME_OVER';

/** TURNS = classic turn order; TIMED = everyone races at once, first to finish wins. */
export type GameMode = 'TURNS' | 'TIMED';

export const GAME_MODES = ['TURNS', 'TIMED'] as const;

export interface PodiumEntry {
  connectionId: string;
  nickname: string;
  position: number;
}

/** Running party-session totals across rematches in the same room. */
export interface SessionPlayerStats {
  connectionId: string;
  nickname: string;
  color: string;
  /** Races this player took part in during the session. */
  races: number;
  /** Times finishing in 1st place. */
  wins: number;
  /** Times finishing in the top 3. */
  podiums: number;
  /** Best single-lap wall time (ms) seen in TIMED races; lower is better. */
  bestLapMs?: number;
  /** Best single-lap round count seen in TURNS races; lower is better. */
  bestLapRounds?: number;
}

/** One recorded move for post-race replay. seq=0 entries mark starting positions. */
export interface MoveRecord {
  /** 0-based sequence number; 0 = starting positions before the first move. */
  seq: number;
  /** Race round when the move was made (0 for starting positions). */
  round: number;
  connectionId: string;
  position: Vector2D;
  velocity: Vector2D;
  isOffTrack: boolean;
  lap: number;
  /** DRS still open after this move. */
  drsActive?: boolean;
  /** This move spent an ERS bar. */
  ersActive?: boolean;
  /** Grass shortcuts taken by this car after this move. */
  grassCuts?: number;
  /** TURNS mode: max gear 1 until this round (inclusive). */
  gearPenaltyUntilRound?: number;
  /** TIMED mode: epoch ms before the player may move again. */
  stopUntil?: number;
  /** Remaining fuel after this move, when the race uses fuel. */
  fuel?: number;
  driveThroughOwed?: number;
  disqualified?: boolean;
}

/** Maximum number of move records stored in the replay log. */
export const MAX_REPLAY_MOVES = 2000;

export function pushReplayMove(state: GameState, record: Omit<MoveRecord, 'seq'>): void {
  if (!state.replayLog) state.replayLog = [];
  if (state.replayLog.length >= MAX_REPLAY_MOVES) return;
  state.replayLog.push({ seq: state.replayLog.length, ...record });
}

export interface GameState {
  phase: GamePhase;
  players: Player[];
  hostId: string;
  trackId: string;
  turnOrder: string[];
  currentTurnIndex: number;
  /** 1-based racing round (increments each time the turn order wraps). */
  round: number;
  /** Race length chosen by the host in the lobby. */
  totalLaps: number;
  /** TURNS (default) or simultaneous TIMED race. */
  gameMode: GameMode;
  diceRolls: Record<string, number>;
  podium: PodiumEntry[];
  /** Epoch ms when the green flag drops (GRID_ORDER_DONE). */
  raceStartedAt?: number;
  /** Move-by-move log for post-race replay. Populated by the host; relayed with final state. */
  replayLog?: MoveRecord[];
  /**
   * Cumulative ranking across rematches in this room.
   * Updated once when a race transitions to GAME_OVER; preserved on return-to-lobby.
   */
  sessionStats?: SessionPlayerStats[];
}

/** Per-player snapshot for telemetry and live standings. */
export interface PlayerTelemetry {
  connectionId: string;
  nickname: string;
  position: Vector2D;
  velocity: Vector2D;
  lap: number;
  finishOrder?: number;
  finishRound?: number;
  finishedAt?: number;
}

/** Host-authoritative race snapshot (positions + elapsed time). */
export interface RaceTelemetrySnapshot {
  timestamp: number;
  round: number;
  elapsedMs: number;
  players: PlayerTelemetry[];
}

export type ClientAction =
  | 'HELLO'
  | 'PING'
  | 'CREATE_ROOM'
  | 'JOIN_ROOM'
  | 'REJOIN_ROOM'
  | 'APPROVE_PLAYER'
  | 'REJECT_PLAYER'
  | 'RELAY'
  | 'REQUEST_HOST_STATE'
  | 'HOST_STATE_RESPONSE'
  | 'FORWARD_TO_HOST'
  | 'SUBMIT_RACE_STATS'
  | 'GET_TOP10'
  | 'SPAWN_AI_PLAYER'
  | 'PLAY_AI_TURN';

export type RelayEventType =
  | 'STATE_SYNC'
  | 'TRACK_SELECTED'
  | 'GRID_ORDER_DONE'
  | 'TURN_ADVANCED'
  | 'PLAYER_FINISHED'
  | 'GAME_OVER';

export type ServerEvent =
  | 'CONNECTED'
  | 'PONG'
  | 'ROOM_CREATED'
  | 'ROOM_REJOINED'
  | 'JOIN_PENDING'
  | 'JOIN_REJECTED'
  | 'PLAYER_APPROVED'
  | 'PLAYER_REJECTED'
  | 'PLAYER_LEFT'
  | 'PLAYER_REJOINED'
  | 'HOST_CHANGED'
  | 'ERROR'
  | 'REQUEST_HOST_STATE'
  | 'HOST_STATE_RESPONSE'
  | 'RELAY'
  | 'PLAYER_ACTION'
  | 'TOP10'
  | 'RACE_STATS_SAVED'
  | 'RELAY_ACK'
  | 'FORWARD_ACK'
  | 'AI_PLAYER_SPAWNING'
  | 'AI_MOVE';

export interface WsEnvelope<T = unknown> {
  action: ClientAction | ServerEvent | 'message';
  payload: T;
  roomCode?: string;
  connectionId?: string;
}

export interface RelayPayload {
  type: RelayEventType;
  state: GameState;
  meta?: Record<string, unknown>;
}

export interface CreateRoomPayload {
  nickname: string;
}

export interface JoinRoomPayload {
  nickname: string;
  roomCode: string;
}

export interface RejoinRoomPayload {
  nickname: string;
  roomCode: string;
  previousConnectionId?: string;
}

export interface RoomRejoinedPayload {
  roomCode: string;
  connectionId: string;
  nickname: string;
  isHost: boolean;
  players: Player[];
  pending: Player[];
}

export interface PlayerRejoinedPayload {
  oldConnectionId: string;
  newConnectionId: string;
  player: Player;
}

export interface ApproveRejectPayload {
  targetConnectionId: string;
}

export interface HostStateResponsePayload {
  targetHostId: string;
  state: GameState;
}

export interface SubmitMoveAction {
  action: 'SUBMIT_MOVE';
  vector: Vector2D;
  /** Ask to open DRS for this move. Host ignores it unless drsArmed. */
  drs?: boolean;
  /** Ask to spend one ERS bar so each axis may change by 2. */
  ers?: boolean;
}

export interface SelectTrackAction {
  action: 'SELECT_TRACK';
  trackId: string;
}

export type PlayerGameAction = SubmitMoveAction | SelectTrackAction;

export const MAX_PLAYERS = 12;
// A lone host may start a race as solo practice mode.
export const MIN_PLAYERS = 1;
export const LAP_OPTIONS = [1, 2, 3, 4, 5, 10, 15, 20, 25] as const;

/** Races longer than this use fuel and the pit lane. */
export const FUEL_RACE_MIN_LAPS = 6;
export const FUEL_TANK = 100;
/** Burn per turn by gear. Index is the gear the car travels at. */
export const FUEL_BURN_BY_GEAR = [0, 1, 1, 2, 3, 4, 5, 6] as const;
export const PIT_MAX_GEAR = 3;
export const FLAGS_PER_DRIVE_THROUGH = 3;

export function isLapOption(laps: number): boolean {
  return (LAP_OPTIONS as readonly number[]).includes(laps);
}

export function fuelEnabled(totalLaps: number): boolean {
  return totalLaps >= FUEL_RACE_MIN_LAPS;
}

export function isPitTile(tile: TileType | null | undefined): boolean {
  return tile === 'pit' || tile === 'pitbox';
}

/** Higher gears burn more. Spending ERS this move halves the burn, rounding down. */
export function fuelBurn(gear: number, spentErs: boolean): number {
  const idx = Math.max(0, Math.min(FUEL_BURN_BY_GEAR.length - 1, gear));
  const base = FUEL_BURN_BY_GEAR[idx];
  return spentErs ? Math.floor(base / 2) : base;
}

export function settleFuel(player: Player, gear: number, spentErs: boolean): void {
  if (player.fuel === undefined) return;
  player.fuel = Math.max(0, player.fuel - fuelBurn(gear, spentErs));
}

export function ownPitBox(track: TrackDefinition, player: Player): Vector2D | undefined {
  if (player.pitBoxIndex === undefined) return undefined;
  return track.pitBoxes?.[player.pitBoxIndex];
}

/**
 * Own stall refills the tank, holds the car for the rest of this round plus
 * the next, and serves one drive-through. Passing through arms a drive-through;
 * leaving the lane without stopping serves it and does not refuel.
 */
export function settlePitVisit(
  player: Player,
  track: TrackDefinition,
  tile: TileType | null,
  round: number
): 'stop' | 'through' | 'exit' | 'none' {
  const box = ownPitBox(track, player);
  const onOwnBox = !!box && player.position.x === box.x && player.position.y === box.y;
  if (onOwnBox) {
    if (player.fuel !== undefined) player.fuel = FUEL_TANK;
    player.velocity = { x: 0, y: 0 };
    player.pitHoldUntilRound = round + 1;
    player.driveThroughArmed = false;
    if ((player.driveThroughOwed ?? 0) > 0) {
      player.driveThroughOwed = (player.driveThroughOwed ?? 0) - 1;
    }
    return 'stop';
  }
  if (isPitTile(tile)) {
    if ((player.driveThroughOwed ?? 0) > 0) player.driveThroughArmed = true;
    return 'through';
  }
  if (player.driveThroughArmed) {
    player.driveThroughOwed = Math.max(0, (player.driveThroughOwed ?? 0) - 1);
    player.driveThroughArmed = false;
    return 'exit';
  }
  return 'none';
}

export const ROOM_CODE_LENGTH = 5;
export const PODIUM_SIZE = 3;

export const PLAYER_COLORS = [
  '#EF4444',
  '#3B82F6',
  '#22C55E',
  '#EAB308',
  '#A855F7',
  '#EC4899',
  '#14B8A6',
  '#F97316',
  '#6366F1',
  '#84CC16',
  '#06B6D4',
  '#F43F5E',
];

export function generateRoomCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += letters[Math.floor(Math.random() * letters.length)];
  }
  return code;
}

export function zeroVector(): Vector2D {
  return { x: 0, y: 0 };
}

export function createLobbyPlayer(
  connectionId: string,
  nickname: string,
  isHost: boolean,
  joinOrder: number,
  color: string
): Player {
  return {
    connectionId,
    nickname,
    color,
    isHost,
    joinOrder,
    status: 'approved',
    position: zeroVector(),
    velocity: zeroVector(),
    isOffTrack: false,
    trail: [],
    lap: 1,
  };
}

export function createInitialState(players: Player[], hostId: string): GameState {
  const approved = players
    .filter((p) => p.status === 'approved')
    .sort((a, b) => a.joinOrder - b.joinOrder);
  return {
    phase: 'LOBBY',
    players: approved.map((p) => ({ ...p })),
    hostId,
    trackId: '',
    turnOrder: [],
    currentTurnIndex: 0,
    round: 1,
    totalLaps: 1,
    gameMode: 'TURNS',
    diceRolls: {},
    podium: [],
    replayLog: [],
  };
}

export function isTimedMode(state: GameState): boolean {
  return state.gameMode === 'TIMED';
}

/** Whether this player may submit a move in the current phase. */
export function canPlayerMove(state: GameState, playerId: string, now = Date.now()): boolean {
  if (state.phase !== 'GAME_ROUND') return false;
  const player = state.players.find((p) => p.connectionId === playerId);
  if (!player || player.finishOrder !== undefined) return false;
  if (isTimedMode(state)) {
    return !isPlayerStopped(player, now);
  }
  return state.turnOrder[state.currentTurnIndex] === playerId;
}

/**
 * Idempotency key for one on-demand AI decision. A retry of the same board
 * position reuses the saved vector; a rejected move appends ":2" on the client.
 */
export function aiTurnToken(state: GameState, player: Player): string {
  if (isTimedMode(state)) {
    const velocity = player.velocity;
    return `${player.connectionId}:${player.lap}:${player.position.x},${player.position.y}:${velocity.x},${velocity.y}:${player.stopUntil ?? 0}`;
  }
  return `${state.round}:${state.currentTurnIndex}:${player.connectionId}`;
}

/** TIMED mode: player is serving a grass-cut stop penalty. */
export function isPlayerStopped(player: Player, now = Date.now()): boolean {
  return player.stopUntil !== undefined && now < player.stopUntil;
}

/** Remaining stop-penalty time in ms (0 if none active). */
export function remainingStopMs(player: Player, now = Date.now()): number {
  if (!player.stopUntil) return 0;
  return Math.max(0, player.stopUntil - now);
}

/** Max gear 1 while off-track or serving a turns-mode grass penalty. */
export function isGearLimited(player: Player, round: number): boolean {
  if (player.isOffTrack) return true;
  return (
    player.gearPenaltyUntilRound !== undefined && round <= player.gearPenaltyUntilRound
  );
}

/** Roll virtual 2d6 (2–12). */
export function rollDice(): number {
  return Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
}

/** Max gear adjustment per axis per turn. */
export const MAX_GEAR_DELTA = 1;

/** Top speed: velocity magnitude (Chebyshev) can never exceed this. */
export const MAX_GEAR = 6;

/** Gear ceiling while DRS is open. Gear 8 is never legal. */
export const DRS_MAX_GEAR = 7;

/** Per-axis step of the 3×3 pad while an ERS bar is spent. */
export const ERS_MAX_DELTA = 2;

/** ERS battery cap, in quarter-bars. */
export const ERS_MAX_CHARGE = 4;

/** Charge gained per gear dropped. */
export const ERS_CHARGE_PER_GEAR = 0.25;

/** Flags the client may set on SUBMIT_MOVE. The host decides if they apply. */
export interface BoostRequest {
  drs?: boolean;
  ers?: boolean;
}

export interface BoostLimits {
  maxGear: number;
  maxDelta: number;
  /** True when this request opens DRS before the gear check. */
  openDrs: boolean;
  /** True when an accepted move spends exactly one ERS bar. */
  spendErs: boolean;
}

/** Off-track players may only use velocity components in this set. */
export const OFF_TRACK_GEARS = [-1, 0, 1] as const;

/** TURNS mode: rounds capped at gear 1 after a grass shortcut. */
export const GRASS_PENALTY_TURNS_FIRST = 5;
export const GRASS_PENALTY_TURNS_REPEAT = 8;

/** TIMED mode: stop duration (ms) after a grass shortcut. */
export const GRASS_PENALTY_TIMED_FIRST_MS = 8000;
export const GRASS_PENALTY_TIMED_REPEAT_MS = 15000;

/**
 * True when a 3×3 step (each axis −2, 0 or +2) points only against travel.
 * Stopped cars have no backwards. A step that still advances on one axis
 * is a steer, not one of the three opposite commands.
 */
export function isErsOppositeStep(velocity: Vector2D, delta: Vector2D): boolean {
  const sx = Math.sign(velocity.x);
  const sy = Math.sign(velocity.y);
  if (sx === 0 && sy === 0) return false;
  const dx = Math.sign(delta.x);
  const dy = Math.sign(delta.y);
  if (dx === 0 && dy === 0) return false;
  const alongX = sx === 0 ? 0 : dx * sx;
  const alongY = sy === 0 ? 0 : dy * sy;
  const forward = (alongX > 0 ? 1 : 0) + (alongY > 0 ? 1 : 0);
  const back = (alongX < 0 ? 1 : 0) + (alongY < 0 ? 1 : 0);
  return back > 0 && forward === 0;
}

/** True when `next` is one of the nine ERS pad steps, other than the opposite three. */
export function isErsPadDelta(current: Vector2D, next: Vector2D): boolean {
  const dx = next.x - current.x;
  const dy = next.y - current.y;
  if (Math.abs(dx) > ERS_MAX_DELTA || Math.abs(dy) > ERS_MAX_DELTA) return false;
  if (dx % ERS_MAX_DELTA !== 0 || dy % ERS_MAX_DELTA !== 0) return false;
  return !isErsOppositeStep(current, { x: dx, y: dy });
}

export function isValidGearChange(
  current: Vector2D,
  next: Vector2D,
  isOffTrack: boolean,
  maxDelta = MAX_GEAR_DELTA,
  maxGear = MAX_GEAR
): boolean {
  // Off-track and grass-penalty limits are not raised by DRS or ERS.
  const delta = isOffTrack ? MAX_GEAR_DELTA : maxDelta;
  if (Math.abs(next.x - current.x) > delta || Math.abs(next.y - current.y) > delta) {
    return false;
  }
  if (isOffTrack) {
    return (
      OFF_TRACK_GEARS.includes(next.x as (typeof OFF_TRACK_GEARS)[number]) &&
      OFF_TRACK_GEARS.includes(next.y as (typeof OFF_TRACK_GEARS)[number])
    );
  }
  // ERS keeps the 3×3 pad at step 2 and rejects the three opposite steps.
  if (delta > MAX_GEAR_DELTA && !isErsPadDelta(current, next)) return false;
  return gearOf(next) <= maxGear;
}

/** Snap ERS charge onto the quarter-bar grid and keep it inside 0–4. */
export function clampErsCharge(value: number): number {
  const snapped = Math.round(value * 4) / 4;
  return Math.min(ERS_MAX_CHARGE, Math.max(0, snapped));
}

/**
 * Ceiling and per-axis delta for a move, given the buttons the client asked
 * for. Defaults stay 6 and 1. Gear-limited cars stay at delta 1 and gear 1.
 */
export function boostLimits(player: Player, round: number, request?: BoostRequest): BoostLimits {
  const limited = isGearLimited(player, round);
  const openDrs = !limited && !!request?.drs && !!player.drsArmed && !player.drsActive;
  const drsOn = !!player.drsActive || openDrs;
  const spendErs = !limited && !!request?.ers && (player.ersCharge ?? 0) >= 1;
  return {
    maxGear: limited ? 1 : drsOn ? DRS_MAX_GEAR : MAX_GEAR,
    maxDelta: limited ? MAX_GEAR_DELTA : spendErs ? ERS_MAX_DELTA : MAX_GEAR_DELTA,
    openDrs,
    spendErs,
  };
}

/**
 * Open DRS before the velocity check when the request is legal. Returns the
 * limits the host must validate against. Call {@link revertDrsOpen} if the
 * vector is then rejected.
 */
export function engageRequestedDrs(player: Player, round: number, request?: BoostRequest): BoostLimits {
  const limits = boostLimits(player, round, request);
  if (limits.openDrs) {
    player.drsActive = true;
    player.drsArmed = false;
  }
  return limits;
}

export function revertDrsOpen(player: Player, drsActive: boolean | undefined, drsArmed: boolean | undefined): void {
  player.drsActive = drsActive;
  player.drsArmed = drsArmed;
}

/** Spend one ERS bar after the host has accepted the move. */
export function spendErsIfAccepted(player: Player, limits: BoostLimits): void {
  if (!limits.spendErs) return;
  player.ersCharge = clampErsCharge((player.ersCharge ?? 0) - 1);
}

/**
 * DRS stays open while the gear holds or rises. Any drop — including a stop
 * on grass or rumble, where the final velocity is {0,0} — closes it and
 * recharges ERS by 0.25 per gear lost.
 */
export function settleBoostFromGears(player: Player, previousGear: number, nextGear: number): void {
  if (nextGear >= previousGear) return;
  player.drsActive = false;
  player.drsArmed = false;
  player.ersCharge = clampErsCharge(
    (player.ersCharge ?? 0) + (previousGear - nextGear) * ERS_CHARGE_PER_GEAR
  );
}

interface RacingGeom {
  lap: number;
  origin: number;
  segs: { ax: number; ay: number; dx: number; dy: number; len: number; arc: number }[];
}

const racingGeomCache = new WeakMap<TrackDefinition, RacingGeom>();

function projectPoint(geom: RacingGeom, p: Vector2D): { arc: number; dist2: number } {
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (const s of geom.segs) {
    const len2 = s.dx * s.dx + s.dy * s.dy;
    let t = 0;
    if (len2 > 0) {
      t = ((p.x - s.ax) * s.dx + (p.y - s.ay) * s.dy) / len2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const px = s.ax + s.dx * t;
    const py = s.ay + s.dy * t;
    const d = (p.x - px) * (p.x - px) + (p.y - py) * (p.y - py);
    if (d < bestD) {
      bestD = d;
      best = s.arc + s.len * t;
    }
  }
  return { arc: best, dist2: bestD };
}

function projectArc(geom: RacingGeom, p: Vector2D): number {
  return projectPoint(geom, p).arc;
}

function racingGeom(track: TrackDefinition): RacingGeom {
  const cached = racingGeomCache.get(track);
  if (cached) return cached;
  const line = track.centerline ?? [];
  const closed =
    line.length > 1 &&
    line[0].x === line[line.length - 1].x &&
    line[0].y === line[line.length - 1].y;
  const segCount = closed ? line.length - 1 : line.length;
  const segs: RacingGeom['segs'] = [];
  let arc = 0;
  for (let i = 0; i < segCount; i++) {
    const a = line[i];
    const b = line[i + 1] ?? line[0];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    segs.push({ ax: a.x, ay: a.y, dx, dy, len, arc });
    arc += len;
  }
  const geom: RacingGeom = { lap: arc || 1, origin: 0, segs };
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < track.height; y++) {
    const row = track.grid[y];
    if (!row) continue;
    for (let x = 0; x < track.width; x++) {
      if (row[x] !== 'finish') continue;
      sx += x;
      sy += y;
      n++;
    }
  }
  if (n > 0) geom.origin = projectArc(geom, { x: sx / n, y: sy / n });
  racingGeomCache.set(track, geom);
  return geom;
}

/**
 * Cells this far from the centerline still belong to that stretch of road.
 * Matches the pen radius the circuits are stamped with.
 */
const DRS_CORRIDOR = 3.51;

/** A straight cut across the road, perpendicular to the sides. */
export interface DrsCut {
  at: Vector2D;
  /** Unit tangent along the racing direction. */
  tangent: Vector2D;
}

/** Asphalt between two perpendicular cuts, resolved from an authoring box. */
export interface ResolvedDrsZone {
  cells: Vector2D[];
  entry: DrsCut;
  exit: DrsCut;
}

interface CachedDrsZone extends ResolvedDrsZone {
  keys: Set<string>;
}

const drsZoneCache = new WeakMap<TrackDefinition, CachedDrsZone[]>();

function arcInSpan(arc: number, from: number, to: number, lap: number): boolean {
  const span = (to - from + lap) % lap;
  const rel = (arc - from + lap) % lap;
  return rel <= span + 1e-3;
}

function spanLength(from: number, to: number, lap: number): number {
  return (to - from + lap) % lap;
}

function cutAt(geom: RacingGeom, arc: number): DrsCut {
  const lap = geom.lap;
  let a = ((arc % lap) + lap) % lap;
  if (a >= lap - 1e-9) a = 0;
  for (const s of geom.segs) {
    if (a > s.arc + s.len + 1e-6) continue;
    if (a < s.arc - 1e-6) continue;
    const len = s.len || 1;
    const t = Math.min(1, Math.max(0, (a - s.arc) / len));
    return {
      at: { x: s.ax + s.dx * t, y: s.ay + s.dy * t },
      tangent: { x: s.dx / len, y: s.dy / len },
    };
  }
  const s = geom.segs[0];
  const len = s.len || 1;
  return { at: { x: s.ax, y: s.ay }, tangent: { x: s.dx / len, y: s.dy / len } };
}

/** Contiguous centerline runs that sit inside the authoring box. */
function spansInsideRect(
  geom: RacingGeom,
  rect: CheckpointRect
): { from: number; to: number }[] {
  const samples: { arc: number; inside: boolean }[] = [];
  for (const s of geom.segs) {
    const steps = Math.max(1, Math.ceil(s.len * 2));
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const x = s.ax + s.dx * t;
      const y = s.ay + s.dy * t;
      samples.push({
        arc: s.arc + s.len * t,
        inside: x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1,
      });
    }
  }
  const n = samples.length;
  if (n === 0) return [];
  const outside = samples.findIndex((s) => !s.inside);
  if (outside === -1) return [{ from: 0, to: geom.lap }];

  const runs: { from: number; to: number }[] = [];
  let idx = outside;
  let seen = 0;
  while (seen < n) {
    if (!samples[idx].inside) {
      idx = (idx + 1) % n;
      seen++;
      continue;
    }
    const start = idx;
    let end = idx;
    let count = 1;
    while (count < n) {
      const next = (end + 1) % n;
      if (!samples[next].inside) break;
      end = next;
      count++;
    }
    const from = samples[start].arc;
    const to = samples[end].arc;
    if (spanLength(from, to, geom.lap) >= 1) runs.push({ from, to });
    idx = (end + 1) % n;
    seen += count;
  }
  return runs;
}

function segmentOverlapsSpan(
  segFrom: number,
  segTo: number,
  from: number,
  to: number,
  lap: number
): boolean {
  const mid = (segFrom + segTo) / 2;
  if (
    arcInSpan(segFrom, from, to, lap) ||
    arcInSpan(mid, from, to, lap) ||
    arcInSpan(segTo, from, to, lap)
  ) {
    return true;
  }
  const insideSeg = (a: number) => a >= segFrom - 1e-6 && a <= segTo + 1e-6;
  return insideSeg(from) || insideSeg(to);
}

/** Track cells whose projection lies on this centerline span, full width. */
function cellsForSpan(track: TrackDefinition, geom: RacingGeom, from: number, to: number): Vector2D[] {
  const r2 = DRS_CORRIDOR * DRS_CORRIDOR;
  const reach = DRS_CORRIDOR + 0.75;
  const reach2 = reach * reach;
  const seen = new Set<string>();
  for (const s of geom.segs) {
    if (!segmentOverlapsSpan(s.arc, s.arc + s.len, from, to, geom.lap)) continue;
    const steps = Math.max(1, Math.ceil(s.len * 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const arc = s.arc + s.len * t;
      if (!arcInSpan(arc, from, to, geom.lap)) continue;
      const cx = s.ax + s.dx * t;
      const cy = s.ay + s.dy * t;
      const minY = Math.max(0, Math.floor(cy - reach));
      const maxY = Math.min(track.height - 1, Math.ceil(cy + reach));
      const minX = Math.max(0, Math.floor(cx - reach));
      const maxX = Math.min(track.width - 1, Math.ceil(cx + reach));
      for (let y = minY; y <= maxY; y++) {
        const row = track.grid[y];
        if (!row) continue;
        for (let x = minX; x <= maxX; x++) {
          if (row[x] !== 'track') continue;
          const dx = x - cx;
          const dy = y - cy;
          if (dx * dx + dy * dy > reach2) continue;
          seen.add(`${x},${y}`);
        }
      }
    }
  }
  const cells: Vector2D[] = [];
  for (const key of seen) {
    const comma = key.indexOf(',');
    const x = Number(key.slice(0, comma));
    const y = Number(key.slice(comma + 1));
    const projected = projectPoint(geom, { x, y });
    if (projected.dist2 > r2) continue;
    if (!arcInSpan(projected.arc, from, to, geom.lap)) continue;
    cells.push({ x, y });
  }
  return cells;
}

function scoreSpan(
  track: TrackDefinition,
  geom: RacingGeom,
  rect: CheckpointRect,
  from: number,
  to: number
): number {
  const r2 = DRS_CORRIDOR * DRS_CORRIDOR;
  const x0 = Math.max(0, Math.floor(rect.x0));
  const x1 = Math.min(track.width - 1, Math.ceil(rect.x1));
  const y0 = Math.max(0, Math.floor(rect.y0));
  const y1 = Math.min(track.height - 1, Math.ceil(rect.y1));
  let count = 0;
  for (let y = y0; y <= y1; y++) {
    const row = track.grid[y];
    if (!row) continue;
    for (let x = x0; x <= x1; x++) {
      if (row[x] !== 'track') continue;
      const projected = projectPoint(geom, { x, y });
      if (projected.dist2 > r2) continue;
      if (arcInSpan(projected.arc, from, to, geom.lap)) count++;
    }
  }
  return count;
}

function resolveDrsZones(track: TrackDefinition): CachedDrsZone[] {
  const cached = drsZoneCache.get(track);
  if (cached) return cached;
  const geom = racingGeom(track);
  const resolved: CachedDrsZone[] = [];
  for (const rect of track.drsZones ?? []) {
    let best: { from: number; to: number; score: number; len: number } | null = null;
    for (const run of spansInsideRect(geom, rect)) {
      const score = scoreSpan(track, geom, rect, run.from, run.to);
      const len = spanLength(run.from, run.to, geom.lap);
      if (
        !best ||
        score > best.score ||
        (score === best.score && len > best.len)
      ) {
        best = { from: run.from, to: run.to, score, len };
      }
    }
    const cells = best && best.score > 0 ? cellsForSpan(track, geom, best.from, best.to) : [];
    const entry = best ? cutAt(geom, best.from) : { at: { x: 0, y: 0 }, tangent: { x: 1, y: 0 } };
    const exit = best ? cutAt(geom, best.to) : { at: { x: 0, y: 0 }, tangent: { x: 1, y: 0 } };
    resolved.push({
      cells,
      entry,
      exit,
      keys: new Set(cells.map((c) => `${c.x},${c.y}`)),
    });
  }
  drsZoneCache.set(track, resolved);
  return resolved;
}

/** Blue DRS areas: full-width asphalt between perpendicular cuts. */
export function resolvedDrsZones(track: TrackDefinition): ResolvedDrsZone[] {
  return resolveDrsZones(track);
}

/** True when this asphalt cell sits in a blue DRS area. */
export function isDrsAsphalt(track: TrackDefinition, x: number, y: number): boolean {
  const key = `${x},${y}`;
  for (const zone of resolveDrsZones(track)) {
    if (zone.keys.has(key)) return true;
  }
  return false;
}

/** True when the straight move passes over one resolved DRS zone. */
export function segmentEntersDrsZone(
  from: Vector2D,
  to: Vector2D,
  track: TrackDefinition,
  zoneIndex: number
): boolean {
  const zone = resolveDrsZones(track)[zoneIndex];
  if (!zone || zone.keys.size === 0) return false;
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) * 4;
  for (let i = 0; i <= Math.max(steps, 1); i++) {
    const t = steps === 0 ? 1 : i / steps;
    const x = Math.round(from.x + (to.x - from.x) * t);
    const y = Math.round(from.y + (to.y - from.y) * t);
    if (zone.keys.has(`${x},${y}`)) return true;
  }
  return false;
}

/**
 * How far `position` is into the current lap, in cells along the directed
 * centerline, measured from the finish stripe. Higher means further ahead.
 * Distance to the checkpoint or the stripe is not monotonic on a straight
 * that bends away from that point, so it cannot order cars inside a DRS zone.
 */
export function racingProgress(position: Vector2D, track: TrackDefinition): number {
  const geom = racingGeom(track);
  if (geom.segs.length === 0) return 0;
  const along = projectArc(geom, position);
  return (along - geom.origin + geom.lap) % geom.lap;
}

/** True when `leader` is strictly ahead of `trailer` in live-standings order. */
export function isStrictlyAhead(leader: Player, trailer: Player, track: TrackDefinition): boolean {
  if (leader.finishOrder !== undefined) return false;
  if (leader.lap !== trailer.lap) return leader.lap > trailer.lap;
  const leaderCp = leader.passedCheckpoint ? 1 : 0;
  const trailerCp = trailer.passedCheckpoint ? 1 : 0;
  if (leaderCp !== trailerCp) return leaderCp > trailerCp;
  return racingProgress(leader.position, track) > racingProgress(trailer.position, track);
}

/** Unfinished rival strictly ahead on the racing line. Distance does not matter. */
export function hasRivalAhead(player: Player, others: Player[], track: TrackDefinition): boolean {
  return others.some((opponent) => {
    if (opponent.connectionId === player.connectionId) return false;
    if (opponent.finishOrder !== undefined) return false;
    return isStrictlyAhead(opponent, player, track);
  });
}

/**
 * Arm DRS when the move is on a still-unused blue zone and a rival is ahead.
 * Any cell of the zone counts, including the first step onto it. The zone is
 * spent when it arms, so the rest of that visit does not arm it again.
 */
export function armDrsZones(
  player: Player,
  from: Vector2D,
  landing: Vector2D,
  others: Player[],
  track: TrackDefinition
): void {
  const zones = track.drsZones ?? [];
  if (zones.length === 0) return;
  const used = new Set(player.drsZonesUsed ?? []);
  const atLanding: Player = { ...player, position: { ...landing } };
  if (!hasRivalAhead(atLanding, others, track)) return;
  let armed = false;
  for (let i = 0; i < zones.length; i++) {
    if (used.has(i)) continue;
    if (!segmentEntersDrsZone(from, landing, track, i)) continue;
    used.add(i);
    armed = true;
  }
  if (!armed) return;
  player.drsArmed = true;
  player.drsZonesUsed = [...used].sort((a, b) => a - b);
}

/** Arm every car that is already standing on an unused blue zone. */
export function syncDrsArms(players: Player[], track: TrackDefinition): void {
  for (const player of players) {
    if (player.finishOrder !== undefined) continue;
    armDrsZones(player, player.position, player.position, players, track);
  }
}

/** Same moment passedCheckpoint returns to false: the lap's DRS zones reset. */
export function beginNextLap(player: Player): void {
  player.passedCheckpoint = false;
  player.drsZonesUsed = [];
}

export function landingPosition(position: Vector2D, velocity: Vector2D): Vector2D {
  return { x: position.x + velocity.x, y: position.y + velocity.y };
}

export function posKey(p: Vector2D): string {
  return `${p.x},${p.y}`;
}

/** Racers still on track (not finished). */
export function activeRacers(players: Player[], excludeId?: string): Player[] {
  return players.filter(
    (p) => p.finishOrder === undefined && p.connectionId !== excludeId
  );
}

/** Racing "gear" = Chebyshev magnitude of the velocity vector. */
export function gearOf(velocity: Vector2D): number {
  return Math.max(Math.abs(velocity.x), Math.abs(velocity.y));
}

/**
 * Grass square that shares a side with the asphalt. The red/white zebra is
 * drawn on that edge. A light kiss of that square is still the kerb; the
 * shortcut rule only gives away its inner quarter.
 */
export function isKerbGrass(track: TrackDefinition, x: number, y: number): boolean {
  if (getTileAt(track, x, y) !== 'grass') return false;
  const beside = (nx: number, ny: number) => {
    const tile = getTileAt(track, nx, ny);
    return tile === 'track' || tile === 'finish';
  };
  return beside(x - 1, y) || beside(x + 1, y) || beside(x, y - 1) || beside(x, y + 1);
}

/**
 * How far the pen may leave the asphalt before it is a shortcut, in cells.
 * A quarter of a zebra square: the line may kiss the border, but the middle
 * of that square (where a car on the kerb actually sits) is already a cut.
 */
const ZEBRA_ALLOWANCE = 0.25;

/** Cells of asphalt to search around a sample. Wider than the allowance so a point just outside still reports a real distance. */
const CLEARANCE_REACH = 2;

function isAsphaltTile(track: TrackDefinition, x: number, y: number): boolean {
  const tile = getTileAt(track, x, y);
  return tile === 'track' || tile === 'finish';
}

/**
 * Chebyshev distance from a point to the nearest asphalt square.
 * Cell (i, j) covers [i, i+1] × [j, j+1]. The drawn line joins cell centers,
 * so a car on cell (x, y) sits at (x+0.5, y+0.5).
 */
function asphaltClearance(track: TrackDefinition, px: number, py: number): number {
  const i0 = Math.floor(px) - CLEARANCE_REACH;
  const i1 = Math.floor(px) + CLEARANCE_REACH;
  const j0 = Math.floor(py) - CLEARANCE_REACH;
  const j1 = Math.floor(py) + CLEARANCE_REACH;
  let best = Infinity;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (!isAsphaltTile(track, i, j)) continue;
      const dx = px < i ? i - px : px > i + 1 ? px - (i + 1) : 0;
      const dy = py < j ? j - py : py > j + 1 ? py - (j + 1) : 0;
      const clearance = Math.max(dx, dy);
      if (clearance < best) best = clearance;
    }
  }
  return best;
}

/** True when the point is more than a quarter of a zebra square off the asphalt. */
function beyondZebraAllowance(track: TrackDefinition, px: number, py: number): boolean {
  return asphaltClearance(track, px, py) > ZEBRA_ALLOWANCE + 1e-9;
}

/**
 * Whether the pen line from → to runs more than a quarter of a zebra square
 * off the asphalt. Samples the segment drawn between cell centers. A car
 * already past the allowance may return without a new cut; the penalty starts
 * when the line leaves the allowance after it was inside. The starting cell
 * itself does not count.
 */
export function segmentCrossesGrass(
  track: TrackDefinition,
  from: Vector2D,
  to: Vector2D
): boolean {
  const x0 = from.x + 0.5;
  const y0 = from.y + 0.5;
  const x1 = to.x + 0.5;
  const y1 = to.y + 0.5;
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(dist / 0.05));
  let inside = !beyondZebraAllowance(track, x0, y0);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const px = x0 + (x1 - x0) * t;
    const py = y0 + (y1 - y0) * t;
    if (Math.floor(px) === from.x && Math.floor(py) === from.y) continue;
    const outside = beyondZebraAllowance(track, px, py);
    if (inside && outside) return true;
    if (!outside) inside = true;
  }
  return false;
}

/** The move clips the zebra square beside the asphalt without entering the infield. */
export function segmentTouchesKerb(
  track: TrackDefinition,
  from: Vector2D,
  to: Vector2D
): boolean {
  if (isKerbGrass(track, to.x, to.y)) return true;
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) * 4;
  for (let i = 0; i <= Math.max(steps, 1); i++) {
    const t = steps === 0 ? 1 : i / steps;
    const x = Math.round(from.x + (to.x - from.x) * t);
    const y = Math.round(from.y + (to.y - from.y) * t);
    if (x === from.x && y === from.y) continue;
    if (isKerbGrass(track, x, y)) return true;
  }
  return false;
}

/**
 * Landing more than a quarter of a zebra square off the asphalt, or a pen
 * line that crosses that line. The inner quarter of the border square (and a
 * return from already being past it) does not count. The center of the kerb
 * square does: that is where the car sits when it takes the green.
 */
export function isGrassShortcut(
  track: TrackDefinition,
  from: Vector2D,
  landing: Vector2D
): boolean {
  const landedPast =
    (landing.x !== from.x || landing.y !== from.y) &&
    beyondZebraAllowance(track, landing.x + 0.5, landing.y + 0.5);
  return landedPast || segmentCrossesGrass(track, from, landing);
}

/**
 * Whether the straight move from → to passes over a rumble-strip tile
 * (excluding the starting cell).
 */
export function segmentCrossesRumble(
  track: TrackDefinition,
  from: Vector2D,
  to: Vector2D
): boolean {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) * 4;
  for (let i = 0; i <= Math.max(steps, 1); i++) {
    const t = steps === 0 ? 1 : i / steps;
    const x = Math.round(from.x + (to.x - from.x) * t);
    const y = Math.round(from.y + (to.y - from.y) * t);
    if (x === from.x && y === from.y) continue;
    if (getTileAt(track, x, y) === 'rumble') return true;
  }
  return false;
}

/**
 * Apply escalating grass-shortcut penalties (host calls after a violation).
 * Every cut kills the car's speed, then holds it at gear 1 (turns) or
 * stopped (timed) long enough that the shortcut is not worth taking.
 */
export function applyGrassPenalty(player: Player, state: GameState, now = Date.now()): void {
  const isRepeat = (player.grassCuts ?? 0) > 0;
  player.grassCuts = (player.grassCuts ?? 0) + 1;
  if (player.grassCuts % FLAGS_PER_DRIVE_THROUGH === 0) {
    player.driveThroughOwed = (player.driveThroughOwed ?? 0) + 1;
  }
  player.velocity = zeroVector();

  if (isTimedMode(state)) {
    const duration = isRepeat ? GRASS_PENALTY_TIMED_REPEAT_MS : GRASS_PENALTY_TIMED_FIRST_MS;
    player.stopUntil = now + duration;
  } else {
    const rounds = isRepeat ? GRASS_PENALTY_TURNS_REPEAT : GRASS_PENALTY_TURNS_FIRST;
    player.gearPenaltyUntilRound = state.round + rounds;
  }
}

/**
 * Whether the straight move from → to passes over a finish tile.
 * Sampled along the segment: a fast car may jump the stripe without
 * landing on it, and that still counts as crossing the line.
 */
export function segmentCrossesFinish(
  track: TrackDefinition,
  from: Vector2D,
  to: Vector2D
): boolean {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) * 4;
  if (steps === 0) {
    return getTileAt(track, to.x, to.y) === 'finish';
  }
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(from.x + (to.x - from.x) * t);
    const y = Math.round(from.y + (to.y - from.y) * t);
    if (getTileAt(track, x, y) === 'finish') return true;
  }
  return false;
}

/** Whether the straight move from → to enters the given checkpoint zone. */
export function segmentEntersRect(
  from: Vector2D,
  to: Vector2D,
  rect: CheckpointRect
): boolean {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) * 4;
  for (let i = 0; i <= Math.max(steps, 1); i++) {
    const t = steps === 0 ? 1 : i / steps;
    const x = Math.round(from.x + (to.x - from.x) * t);
    const y = Math.round(from.y + (to.y - from.y) * t);
    if (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) return true;
  }
  return false;
}

/** Trail history cap — bounds RELAY payload size on long races. */
export const MAX_TRAIL_POINTS = 300;

export function pushTrail(player: Player, point: Vector2D): void {
  player.trail.push({ ...point });
  if (player.trail.length > MAX_TRAIL_POINTS) {
    player.trail.shift();
  }
}

export function getTileAt(track: TrackDefinition, x: number, y: number): TileType | null {
  if (y < 0 || y >= track.height || x < 0 || x >= track.width) return null;
  return track.grid[y][x];
}

/**
 * Enumerate valid next velocities and landing squares.
 * Used both for UI highlighting and host-side move validation.
 * Cars may cross each other's paths, but cannot land on an occupied cell.
 * If every normal candidate lands outside the grid, an emergency stop
 * (velocity {0,0}, stay in place) is offered so the game never soft-locks.
 * An ERS request (maxDelta above 1) returns the 3×3 steps of 2, except the three opposite ones.
 */
export function getValidMoves(
  player: Player,
  track: TrackDefinition,
  others?: Player[],
  round = 1,
  maxGear = MAX_GEAR,
  maxDelta = MAX_GEAR_DELTA
): { velocity: Vector2D; landing: Vector2D }[] {
  const moves: { velocity: Vector2D; landing: Vector2D }[] = [];
  const { position, velocity } = player;
  const gearLimited = isGearLimited(player, round);
  const delta = gearLimited ? MAX_GEAR_DELTA : maxDelta;
  const cap = gearLimited ? 1 : maxGear;
  const outOfFuel = player.fuel !== undefined && player.fuel <= 0;
  const here = getTileAt(track, position.x, position.y);
  const opponents = others ? activeRacers(others, player.connectionId) : [];

  for (let dvx = -delta; dvx <= delta; dvx++) {
    for (let dvy = -delta; dvy <= delta; dvy++) {
      const next: Vector2D = { x: velocity.x + dvx, y: velocity.y + dvy };
      if (!isValidGearChange(velocity, next, gearLimited, delta, cap)) continue;
      if (outOfFuel && gearOf(next) > 1) continue;
      const landing = landingPosition(position, next);
      const landingTile = getTileAt(track, landing.x, landing.y);
      if (landingTile === null) continue;
      if ((isPitTile(here) || isPitTile(landingTile)) && gearOf(next) > PIT_MAX_GEAR) continue;
      if (opponents.some((o) => o.position.x === landing.x && o.position.y === landing.y)) {
        continue;
      }
      moves.push({ velocity: next, landing });
    }
  }

  // ERS with nowhere to accelerate is not an emergency stop — the player
  // turns it off and uses the normal pad. A stop here would spend the bar.
  if (moves.length === 0 && delta <= MAX_GEAR_DELTA) {
    moves.push({ velocity: zeroVector(), landing: { ...position } });
  }
  return moves;
}

export function nextActiveTurnIndex(state: GameState): number {
  if (state.turnOrder.length === 0) return 0;
  let idx = state.currentTurnIndex;
  for (let i = 0; i < state.turnOrder.length; i++) {
    idx = (idx + 1) % state.turnOrder.length;
    const id = state.turnOrder[idx];
    const player = state.players.find((p) => p.connectionId === id);
    if (player && player.finishOrder === undefined) {
      return idx;
    }
  }
  return state.currentTurnIndex;
}

export function isGameOver(state: GameState): boolean {
  if (isTimedMode(state)) {
    return state.podium.length >= 1;
  }
  const racing = state.players.filter((p) => p.finishOrder === undefined);
  // Humans may finish after the podium is full. Bots keep racing until they
  // finish too, unless the host ends the race from the button.
  return racing.length === 0 && state.turnOrder.length > 0;
}

/** Build a telemetry snapshot from the current game state. */
export function buildRaceTelemetry(
  state: GameState,
  now = Date.now()
): RaceTelemetrySnapshot | null {
  if (!state.raceStartedAt || state.phase === 'LOBBY' || state.phase === 'GRID_ORDER') {
    return null;
  }
  return {
    timestamp: now,
    round: state.round,
    elapsedMs: Math.max(0, now - state.raceStartedAt),
    players: state.players.map((p) => ({
      connectionId: p.connectionId,
      nickname: p.nickname,
      position: { ...p.position },
      velocity: { ...p.velocity },
      lap: p.lap,
      finishOrder: p.finishOrder,
      finishRound: p.finishRound,
      finishedAt: p.finishedAt,
    })),
  };
}

/** One row in the in-race classification table. */
export interface LiveStandingRow {
  connectionId: string;
  nickname: string;
  color: string;
  /** 1-based race position. */
  rank: number;
  lap: number;
  finishOrder?: number;
  isOffTrack: boolean;
  passedCheckpoint: boolean;
  disqualified?: boolean;
}

/**
 * Live race order for the classification panel.
 * Finishers keep their finishOrder; everyone else is ranked by lap, checkpoint,
 * then distance along the racing line (further = ahead).
 */
export function buildLiveStandings(
  state: GameState,
  track: TrackDefinition | undefined
): LiveStandingRow[] {
  const finishers = state.players
    .filter((p) => p.finishOrder !== undefined)
    .sort((a, b) => (a.finishOrder ?? 0) - (b.finishOrder ?? 0));

  const racing = state.players
    .filter((p) => p.finishOrder === undefined)
    .sort((a, b) => {
      if (b.lap !== a.lap) return b.lap - a.lap;
      const aCp = a.passedCheckpoint ? 1 : 0;
      const bCp = b.passedCheckpoint ? 1 : 0;
      if (bCp !== aCp) return bCp - aCp;
      if (track) {
        const d = racingProgress(b.position, track) - racingProgress(a.position, track);
        if (d !== 0) return d;
      }
      return a.nickname.localeCompare(b.nickname);
    });

  return [...finishers, ...racing].map((p, i) => ({
    connectionId: p.connectionId,
    nickname: p.nickname,
    color: p.color,
    rank: i + 1,
    lap: p.lap,
    finishOrder: p.finishOrder,
    isOffTrack: p.isOffTrack,
    passedCheckpoint: !!p.passedCheckpoint,
    disqualified: !!p.disqualified,
  }));
}

/** Format elapsed race time as m:ss. */
export function formatRaceTime(elapsedMs: number): string {
  const totalSec = Math.floor(Math.max(0, elapsedMs) / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

/**
 * Wall-clock duration of a completed lap (1-based).
 * Lap 1 is measured from raceStartedAt (or the first stamp if missing).
 */
export function lapSplitMs(
  player: Pick<Player, 'lapTimes'>,
  lapNumber: number,
  raceStartedAt?: number
): number | undefined {
  const times = player.lapTimes ?? [];
  const idx = lapNumber - 1;
  if (times.length <= idx) return undefined;
  const from = idx === 0 ? (raceStartedAt ?? times[0]) : times[idx - 1];
  return Math.max(0, times[idx] - from);
}

/**
 * Round count of a completed lap (1-based).
 * Lap 1 is measured from round 0 (before the green flag).
 */
export function lapSplitRounds(
  player: Pick<Player, 'lapRounds'>,
  lapNumber: number
): number | undefined {
  const rounds = player.lapRounds ?? [];
  const idx = lapNumber - 1;
  if (rounds.length <= idx) return undefined;
  const from = idx === 0 ? 0 : rounds[idx - 1];
  return Math.max(0, rounds[idx] - from);
}

/** Fastest completed lap time (ms) for a player in the current race. */
export function bestLapMs(
  player: Pick<Player, 'lapTimes'>,
  raceStartedAt?: number
): number | undefined {
  const times = player.lapTimes ?? [];
  if (times.length === 0) return undefined;
  let best: number | undefined;
  for (let i = 1; i <= times.length; i++) {
    const split = lapSplitMs(player, i, raceStartedAt);
    if (split === undefined) continue;
    if (best === undefined || split < best) best = split;
  }
  return best;
}

/** Fewest rounds used on any completed lap for a player in the current race. */
export function bestLapRounds(player: Pick<Player, 'lapRounds'>): number | undefined {
  const rounds = player.lapRounds ?? [];
  if (rounds.length === 0) return undefined;
  let best: number | undefined;
  for (let i = 1; i <= rounds.length; i++) {
    const split = lapSplitRounds(player, i);
    if (split === undefined) continue;
    if (best === undefined || split < best) best = split;
  }
  return best;
}

/** Connection id(s) that set the race's fastest lap (TIMED). Empty if none. */
export function fastestLapHolderIds(state: GameState): string[] {
  let best = Number.POSITIVE_INFINITY;
  const holders: string[] = [];
  for (const p of state.players) {
    const v = bestLapMs(p, state.raceStartedAt);
    if (v === undefined) continue;
    if (v < best) {
      best = v;
      holders.length = 0;
      holders.push(p.connectionId);
    } else if (v === best) {
      holders.push(p.connectionId);
    }
  }
  return holders;
}

/** Connection id(s) that set the race's fewest-round lap (TURNS). Empty if none. */
export function fewestRoundLapHolderIds(state: GameState): string[] {
  let best = Number.POSITIVE_INFINITY;
  const holders: string[] = [];
  for (const p of state.players) {
    const v = bestLapRounds(p);
    if (v === undefined) continue;
    if (v < best) {
      best = v;
      holders.length = 0;
      holders.push(p.connectionId);
    } else if (v === best) {
      holders.push(p.connectionId);
    }
  }
  return holders;
}

/**
 * Fold the finished race into sessionStats (mutates state).
 * Call exactly once when transitioning to GAME_OVER.
 */
export function updateSessionStats(state: GameState): void {
  const byId = new Map<string, SessionPlayerStats>(
    (state.sessionStats ?? []).map((s) => [s.connectionId, { ...s }])
  );

  for (const p of state.players) {
    const prev = byId.get(p.connectionId);
    const entry: SessionPlayerStats = prev ?? {
      connectionId: p.connectionId,
      nickname: p.nickname,
      color: p.color,
      races: 0,
      wins: 0,
      podiums: 0,
    };
    entry.nickname = p.nickname;
    entry.color = p.color;
    entry.races += 1;
    if (!p.disqualified && p.finishOrder === 1) entry.wins += 1;
    if (!p.disqualified && p.finishOrder !== undefined && p.finishOrder <= PODIUM_SIZE) entry.podiums += 1;

    // Wall-clock splits only count in TIMED mode. In TURNS they include waiting
    // for other players and look like total race time on the leaderboard.
    if (isTimedMode(state)) {
      const lapMs = bestLapMs(p, state.raceStartedAt);
      if (lapMs !== undefined && (entry.bestLapMs === undefined || lapMs < entry.bestLapMs)) {
        entry.bestLapMs = lapMs;
      }
    }
    const lapRounds = bestLapRounds(p);
    if (
      lapRounds !== undefined &&
      (entry.bestLapRounds === undefined || lapRounds < entry.bestLapRounds)
    ) {
      entry.bestLapRounds = lapRounds;
    }
    byId.set(p.connectionId, entry);
  }

  state.sessionStats = [...byId.values()];
}

/** Session ranking sorted for display: wins → best lap → best rounds → podiums → name. */
export function buildSessionRanking(state: GameState): SessionPlayerStats[] {
  const rows = [...(state.sessionStats ?? [])];
  rows.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    const aLap = a.bestLapMs ?? Number.POSITIVE_INFINITY;
    const bLap = b.bestLapMs ?? Number.POSITIVE_INFINITY;
    if (aLap !== bLap) return aLap - bLap;
    const aRounds = a.bestLapRounds ?? Number.POSITIVE_INFINITY;
    const bRounds = b.bestLapRounds ?? Number.POSITIVE_INFINITY;
    if (aRounds !== bRounds) return aRounds - bRounds;
    if (b.podiums !== a.podiums) return b.podiums - a.podiums;
    return a.nickname.localeCompare(b.nickname);
  });
  return rows;
}

/**
 * Point every reference of `oldConnectionId` at `newConnectionId`.
 * Used when a phone reconnects or an AI Lambda rotates mid-race.
 */
export function remapPlayerConnection(
  state: GameState,
  oldConnectionId: string,
  newConnectionId: string
): void {
  if (!oldConnectionId || oldConnectionId === newConnectionId) return;
  state.turnOrder = state.turnOrder.map((id) => (id === oldConnectionId ? newConnectionId : id));
  if (state.diceRolls[oldConnectionId] !== undefined) {
    state.diceRolls[newConnectionId] = state.diceRolls[oldConnectionId];
    delete state.diceRolls[oldConnectionId];
  }
  state.podium = state.podium.map((entry) =>
    entry.connectionId === oldConnectionId ? { ...entry, connectionId: newConnectionId } : entry
  );
  remapSessionStatsConnectionId(state, oldConnectionId, newConnectionId);
  remapReplayLogConnectionId(state, oldConnectionId, newConnectionId);
  if (state.hostId === oldConnectionId) state.hostId = newConnectionId;
  for (const player of state.players) {
    if (player.connectionId === oldConnectionId) player.connectionId = newConnectionId;
  }
}

/**
 * After an AI Lambda handoff the board can still name the old socket.
 * If `newConnectionId` is unknown and `nickname` matches a car, retarget that car.
 * Returns true when a retarget happened.
 */
export function adoptNicknameConnection(
  state: GameState,
  nickname: string,
  newConnectionId: string
): boolean {
  const name = nickname.trim();
  if (!name || !newConnectionId) return false;
  if (state.players.some((player) => player.connectionId === newConnectionId)) return false;
  const existing = state.players.find((player) => player.nickname === name);
  if (!existing) return false;
  remapPlayerConnection(state, existing.connectionId, newConnectionId);
  return true;
}

/**
 * Point this phone's car at its new socket id.
 * A reconnect updates the room connection id but the race lives only on the
 * host, so without this the turn stays on the old id and the pad never enables.
 * Returns true when the board changed.
 */
export function retargetLocalPlayer(
  state: GameState,
  previousConnectionId: string | null,
  nextConnectionId: string,
  nickname: string
): boolean {
  if (!nextConnectionId || previousConnectionId === nextConnectionId) return false;
  if (state.players.some((player) => player.connectionId === nextConnectionId)) return false;
  const fromKnown =
    previousConnectionId &&
    state.players.some((player) => player.connectionId === previousConnectionId)
      ? previousConnectionId
      : undefined;
  const fromNick = state.players.find((player) => player.nickname === nickname.trim())?.connectionId;
  const fromId = fromKnown ?? fromNick;
  if (!fromId || fromId === nextConnectionId) return false;
  remapPlayerConnection(state, fromId, nextConnectionId);
  for (const player of state.players) {
    player.isHost = player.connectionId === state.hostId;
  }
  return true;
}

/** Remap session-stat keys when a player reconnects with a new connection id. */
export function remapSessionStatsConnectionId(
  state: GameState,
  oldConnectionId: string,
  newConnectionId: string
): void {
  if (!state.sessionStats) return;
  state.sessionStats = state.sessionStats.map((s) =>
    s.connectionId === oldConnectionId ? { ...s, connectionId: newConnectionId } : s
  );
}

/**
 * Remap move-log ids on reconnect / AI Lambda handoff.
 * Without this, one pilot splits into two ids in the post-race replay
 * (frozen at the handoff cell, then a second car jumps in near the finish).
 */
export function remapReplayLogConnectionId(
  state: GameState,
  oldConnectionId: string,
  newConnectionId: string
): void {
  if (!state.replayLog?.length) return;
  state.replayLog = state.replayLog.map((r) =>
    r.connectionId === oldConnectionId ? { ...r, connectionId: newConnectionId } : r
  );
}

/** Per-race delta sent to the server to persist nickname stats on one track. */
export interface RaceStatDelta {
  nickname: string;
  trackId: string;
  races: number;
  wins: number;
  podiums: number;
  bestLapMs?: number;
  bestLapRounds?: number;
}

/** One row in the global Top 10. Same nickname may appear once per track. */
export interface Top10Entry {
  nickname: string;
  trackId: string;
  races: number;
  wins: number;
  podiums: number;
  bestLapMs?: number;
  bestLapRounds?: number;
}

/**
 * Lobby AI pilots use "Bot …" / "IA …" nicknames (optionally with a difficulty
 * suffix). They must not pollute the global Top 10.
 */
export function isAiPilotNickname(nickname: string): boolean {
  return /^(Bot|IA)\s/i.test(nickname.trim());
}

/**
 * Build host-submitted per-race deltas from the finished GameState.
 * One entry per human player who took part; counters are 0/1 for this race only.
 *
 * bestLapMs is only included for TIMED races — TURNS wall-clock splits include
 * waiting time and were being saved as bogus "best laps" (often ≈ race total).
 */
export function buildRaceStatDeltas(state: GameState): RaceStatDelta[] {
  return state.players
    .filter((p) => !isAiPilotNickname(p.nickname))
    .map((p) => {
      const delta: RaceStatDelta = {
        nickname: p.nickname,
        trackId: state.trackId,
        races: 1,
        wins: !p.disqualified && p.finishOrder === 1 ? 1 : 0,
        podiums:
          !p.disqualified && p.finishOrder !== undefined && p.finishOrder <= PODIUM_SIZE ? 1 : 0,
      };
      if (isTimedMode(state)) {
        const lapMs = bestLapMs(p, state.raceStartedAt);
        if (lapMs !== undefined) delta.bestLapMs = lapMs;
      }
      const rounds = bestLapRounds(p);
      if (rounds !== undefined) delta.bestLapRounds = rounds;
      return delta;
    });
}
