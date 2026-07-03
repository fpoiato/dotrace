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

export type TileType = 'track' | 'grass' | 'finish';

export interface TrackDefinition {
  id: string;
  nameKey: string;
  width: number;
  height: number;
  grid: TileType[][];
  startLine: Vector2D[];
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
  diceRoll?: number;
  finishOrder?: number;
}

export type GamePhase = 'LOBBY' | 'GRID_ORDER' | 'GAME_ROUND' | 'GAME_OVER';

export interface PodiumEntry {
  connectionId: string;
  nickname: string;
  position: number;
}

export interface GameState {
  phase: GamePhase;
  players: Player[];
  hostId: string;
  trackId: string;
  turnOrder: string[];
  currentTurnIndex: number;
  diceRolls: Record<string, number>;
  podium: PodiumEntry[];
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
export const MIN_PLAYERS = 2;
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
    diceRolls: {},
    podium: [],
  };
}

/** Roll virtual 2d6 (2–12). */
export function rollDice(): number {
  return Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
}

/** Max gear adjustment per axis per turn. */
export const MAX_GEAR_DELTA = 1;

/** Off-track players may only use velocity components in this set. */
export const OFF_TRACK_GEARS = [-1, 0, 1] as const;

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
  return true;
}

export function landingPosition(position: Vector2D, velocity: Vector2D): Vector2D {
  return { x: position.x + velocity.x, y: position.y + velocity.y };
}

export function posKey(p: Vector2D): string {
  return `${p.x},${p.y}`;
}

export function getTileAt(track: TrackDefinition, x: number, y: number): TileType | null {
  if (y < 0 || y >= track.height || x < 0 || x >= track.width) return null;
  return track.grid[y][x];
}

/**
 * Enumerate valid next velocities and landing squares.
 * Used both for UI highlighting and host-side move validation.
 * If every candidate lands outside the grid, an emergency stop
 * (velocity {0,0}, stay in place) is offered so the game never soft-locks.
 */
export function getValidMoves(
  player: Player,
  track: TrackDefinition
): { velocity: Vector2D; landing: Vector2D }[] {
  const moves: { velocity: Vector2D; landing: Vector2D }[] = [];
  const { position, velocity, isOffTrack } = player;

  for (let dvx = -MAX_GEAR_DELTA; dvx <= MAX_GEAR_DELTA; dvx++) {
    for (let dvy = -MAX_GEAR_DELTA; dvy <= MAX_GEAR_DELTA; dvy++) {
      const next: Vector2D = { x: velocity.x + dvx, y: velocity.y + dvy };
      if (!isValidGearChange(velocity, next, isOffTrack)) continue;
      const landing = landingPosition(position, next);
      if (getTileAt(track, landing.x, landing.y) === null) continue;
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
  if (state.podium.length >= PODIUM_SIZE) return true;
  const racing = state.players.filter((p) => p.finishOrder === undefined);
  return racing.length === 0 && state.turnOrder.length > 0;
}
