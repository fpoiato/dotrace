import type { GameState, Player, TrackDefinition, Vector2D, WsEnvelope } from '../../shared/ws-types.ts';

export interface BotConfig {
  url: string;
  nickname: string;
  roomCode?: string;
  createRoom: boolean;
  reconnectMinMs: number;
  reconnectMaxMs: number;
}

export interface RoomContext {
  roomCode?: string;
  nickname: string;
  connectionId?: string;
  previousConnectionId?: string;
  isHost: boolean;
  approved: boolean;
}

export interface CarState {
  id: string;
  nickname: string;
  position: Vector2D;
  velocity: Vector2D;
  isOffTrack: boolean;
  passedCheckpoint?: boolean;
  finishOrder?: number;
}

export interface TrackState extends TrackDefinition {}

export interface ParsedTurnState {
  protocol: 'dotrace';
  envelope: WsEnvelope;
  roomCode?: string;
  gameState: GameState;
  self: Player;
  car: CarState;
  track: TrackState;
}

export interface GenericTurnState {
  protocol: 'generic';
  envelope: WsEnvelope | Record<string, unknown>;
  car: CarState;
  track: TrackState;
}

export type TurnState = ParsedTurnState | GenericTurnState;

export interface Acceleration {
  dx: number;
  dy: number;
}

export interface MoveDecision {
  acceleration: Acceleration;
  velocity: Vector2D;
  landing: Vector2D;
  reason: string;
}
