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

export type TileType = 'track' | 'grass' | 'finish' | 'rumble';

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
   * Zone (usually the far side of the circuit) a car must have visited before
   * landing on the finish stripe counts as completing the lap. Prevents
   * "finishing" by reversing over the line on turn one.
   */
  checkpoint?: CheckpointRect;
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
  | 'CREATE_ROOM'
  | 'JOIN_ROOM'
  | 'REJOIN_ROOM'
  | 'APPROVE_PLAYER'
  | 'REJECT_PLAYER'
  | 'RELAY'
  | 'REQUEST_HOST_STATE'
  | 'HOST_STATE_RESPONSE'
  | 'FORWARD_TO_HOST';

export type RelayEventType =
  | 'STATE_SYNC'
  | 'TRACK_SELECTED'
  | 'GRID_ORDER_DONE'
  | 'TURN_ADVANCED'
  | 'PLAYER_FINISHED'
  | 'GAME_OVER';

export type ServerEvent =
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
  | 'PLAYER_ACTION';

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
}

export interface SelectTrackAction {
  action: 'SELECT_TRACK';
  trackId: string;
}

export type PlayerGameAction = SubmitMoveAction | SelectTrackAction;

export const MAX_PLAYERS = 12;
// A lone host may start a race as solo practice mode.
export const MIN_PLAYERS = 1;
export const LAP_OPTIONS = [1, 2, 3] as const;
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

/** Off-track players may only use velocity components in this set. */
export const OFF_TRACK_GEARS = [-1, 0, 1] as const;

/** TURNS mode: rounds capped at gear 1 after a grass shortcut. */
export const GRASS_PENALTY_TURNS_FIRST = 3;
export const GRASS_PENALTY_TURNS_REPEAT = 5;

/** TIMED mode: stop duration (ms) after a grass shortcut. */
export const GRASS_PENALTY_TIMED_FIRST_MS = 5000;
export const GRASS_PENALTY_TIMED_REPEAT_MS = 10000;

export function isValidGearChange(
  current: Vector2D,
  next: Vector2D,
  isOffTrack: boolean
): boolean {
  if (
    Math.abs(next.x - current.x) > MAX_GEAR_DELTA ||
    Math.abs(next.y - current.y) > MAX_GEAR_DELTA
  ) {
    return false;
  }
  if (isOffTrack) {
    return (
      OFF_TRACK_GEARS.includes(next.x as (typeof OFF_TRACK_GEARS)[number]) &&
      OFF_TRACK_GEARS.includes(next.y as (typeof OFF_TRACK_GEARS)[number])
    );
  }
  return gearOf(next) <= MAX_GEAR;
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
 * Whether the straight move from → to passes over a grass tile (excluding
 * the starting cell — already being on grass is not a shortcut).
 */
export function segmentCrossesGrass(
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
    if (getTileAt(track, x, y) === 'grass') return true;
  }
  return false;
}

/** Landing on grass or cutting through it on the way. */
export function isGrassShortcut(
  track: TrackDefinition,
  from: Vector2D,
  landing: Vector2D
): boolean {
  return (
    getTileAt(track, landing.x, landing.y) === 'grass' ||
    segmentCrossesGrass(track, from, landing)
  );
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

/** Apply escalating grass-shortcut penalties (host calls after a violation). */
export function applyGrassPenalty(player: Player, state: GameState, now = Date.now()): void {
  const isRepeat = (player.grassCuts ?? 0) > 0;
  player.grassCuts = (player.grassCuts ?? 0) + 1;

  if (isTimedMode(state)) {
    const duration = isRepeat ? GRASS_PENALTY_TIMED_REPEAT_MS : GRASS_PENALTY_TIMED_FIRST_MS;
    player.stopUntil = now + duration;
    if (isRepeat) {
      player.velocity = zeroVector();
    }
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
 * If every candidate lands outside the grid, an emergency stop
 * (velocity {0,0}, stay in place) is offered so the game never soft-locks.
 */
export function getValidMoves(
  player: Player,
  track: TrackDefinition,
  others?: Player[],
  round = 1
): { velocity: Vector2D; landing: Vector2D }[] {
  const moves: { velocity: Vector2D; landing: Vector2D }[] = [];
  const { position, velocity } = player;
  const gearLimited = isGearLimited(player, round);
  const opponents = others ? activeRacers(others, player.connectionId) : [];

  for (let dvx = -MAX_GEAR_DELTA; dvx <= MAX_GEAR_DELTA; dvx++) {
    for (let dvy = -MAX_GEAR_DELTA; dvy <= MAX_GEAR_DELTA; dvy++) {
      const next: Vector2D = { x: velocity.x + dvx, y: velocity.y + dvy };
      if (!isValidGearChange(velocity, next, gearLimited)) continue;
      const landing = landingPosition(position, next);
      if (getTileAt(track, landing.x, landing.y) === null) continue;
      if (opponents.some((o) => o.position.x === landing.x && o.position.y === landing.y)) {
        continue;
      }
      moves.push({ velocity: next, landing });
    }
  }

  if (moves.length === 0) {
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
  if (state.podium.length >= PODIUM_SIZE) return true;
  const racing = state.players.filter((p) => p.finishOrder === undefined);
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

/** Format elapsed race time as m:ss. */
export function formatRaceTime(elapsedMs: number): string {
  const totalSec = Math.floor(Math.max(0, elapsedMs) / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}
