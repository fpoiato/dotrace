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
 * Grass square that shares a side with the asphalt. The red/white zebra is
 * drawn on that edge, so clipping or landing here is the kerb, not a shortcut
 * through the infield.
 */
export function isKerbGrass(track: TrackDefinition, x: number, y: number): boolean {
  if (getTileAt(track, x, y) !== 'grass') return false;
  const beside = (nx: number, ny: number) => {
    const tile = getTileAt(track, nx, ny);
    return tile === 'track' || tile === 'finish';
  };
  return beside(x - 1, y) || beside(x + 1, y) || beside(x, y - 1) || beside(x, y + 1);
}

/** Grass beyond the zebra square — a real shortcut, not the border kerb. */
function isInfieldGrass(track: TrackDefinition, x: number, y: number): boolean {
  return getTileAt(track, x, y) === 'grass' && !isKerbGrass(track, x, y);
}

/**
 * Whether the straight move from → to passes over infield grass (excluding
 * the starting cell, and excluding the zebra square beside the asphalt).
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
    if (isInfieldGrass(track, x, y)) return true;
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

/** Landing in the infield, or cutting through it. The zebra square does not count. */
export function isGrassShortcut(
  track: TrackDefinition,
  from: Vector2D,
  landing: Vector2D
): boolean {
  return isInfieldGrass(track, landing.x, landing.y) || segmentCrossesGrass(track, from, landing);
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
  if (racing.length === 0 && state.turnOrder.length > 0) return true;
  // A human already finished and only AI pilots are still on track. Waiting
  // them out freezes the podium and the replay, so the race ends here.
  const humans = state.players.filter((p) => !isAiPilotNickname(p.nickname));
  const humansStillRacing = humans.some((p) => p.finishOrder === undefined);
  return humans.length > 0 && !humansStillRacing && state.podium.length > 0;
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
}

function chebyshev(a: Vector2D, b: Vector2D): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function checkpointCenter(rect: CheckpointRect): Vector2D {
  return {
    x: (rect.x0 + rect.x1) / 2,
    y: (rect.y0 + rect.y1) / 2,
  };
}

function nearestFinishDistance(track: TrackDefinition, pos: Vector2D): number {
  let best = Number.POSITIVE_INFINITY;
  for (let y = 0; y < track.height; y++) {
    for (let x = 0; x < track.width; x++) {
      if (getTileAt(track, x, y) !== 'finish') continue;
      const d = chebyshev(pos, { x, y });
      if (d < best) best = d;
    }
  }
  return Number.isFinite(best) ? best : 0;
}

/** Distance to the current lap goal (checkpoint, then finish stripe). */
export function distanceToRaceGoal(player: Player, track: TrackDefinition): number {
  if (track.checkpoint && !player.passedCheckpoint) {
    return chebyshev(player.position, checkpointCenter(track.checkpoint));
  }
  return nearestFinishDistance(track, player.position);
}

/**
 * Live race order for the classification panel.
 * Finishers keep their finishOrder; everyone else is ranked by lap, checkpoint
 * progress, then distance to the current goal (closer = ahead).
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
        const d = distanceToRaceGoal(a, track) - distanceToRaceGoal(b, track);
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
    if (p.finishOrder === 1) entry.wins += 1;
    if (p.finishOrder !== undefined && p.finishOrder <= PODIUM_SIZE) entry.podiums += 1;

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

/** Per-race delta sent to the server to persist global nickname stats. */
export interface RaceStatDelta {
  nickname: string;
  races: number;
  wins: number;
  podiums: number;
  bestLapMs?: number;
  bestLapRounds?: number;
}

/** One row in the global Top 10 leaderboard. */
export interface Top10Entry {
  nickname: string;
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
        races: 1,
        wins: p.finishOrder === 1 ? 1 : 0,
        podiums: p.finishOrder !== undefined && p.finishOrder <= PODIUM_SIZE ? 1 : 0,
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
