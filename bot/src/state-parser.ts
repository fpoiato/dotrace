import { getTrackById } from '../../shared/tracks.ts';
import { canPlayerMove, type GameState, type Player, type WsEnvelope } from '../../shared/ws-types.ts';
import type { CarState, GenericTurnState, ParsedTurnState, TrackState, TurnState } from './types.ts';

export function parseEnvelope(raw: string): WsEnvelope | Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? (parsed as WsEnvelope | Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseTurnState(
  envelope: WsEnvelope | Record<string, unknown>,
  selfConnectionId?: string
): TurnState | null {
  return parseDotRaceTurn(envelope, selfConnectionId) ?? parseGenericTurn(envelope);
}

function parseDotRaceTurn(
  envelope: WsEnvelope | Record<string, unknown>,
  selfConnectionId?: string
): ParsedTurnState | null {
  if (!selfConnectionId || envelope.action !== 'RELAY' || !isObject(envelope.payload)) {
    return null;
  }

  const state = (envelope.payload as { state?: unknown }).state;
  if (!isGameStateShape(state) || !canPlayerMove(state, selfConnectionId)) {
    return null;
  }

  const self = state.players.find((player) => player.connectionId === selfConnectionId);
  const track = state.trackId ? getTrackById(state.trackId) : undefined;
  if (!self || !track) {
    return null;
  }

  return {
    protocol: 'dotrace',
    envelope: envelope as WsEnvelope,
    roomCode: (envelope as WsEnvelope).roomCode,
    gameState: state,
    self,
    car: toCarState(self),
    track,
  };
}

function parseGenericTurn(envelope: WsEnvelope | Record<string, unknown>): GenericTurnState | null {
  const message = envelope as Record<string, unknown>;
  if (message.type !== 'YOUR_TURN' || !isObject(message.gameState)) {
    return null;
  }

  const gameState = message.gameState as Record<string, unknown>;
  if (!isObject(gameState.car) || !isObject(gameState.track)) {
    return null;
  }

  const car = gameState.car as Record<string, unknown>;
  const track = gameState.track as Record<string, unknown>;
  if (!isNumber(car.x) || !isNumber(car.y) || !isNumber(car.vx) || !isNumber(car.vy)) {
    return null;
  }
  if (!isNumber(track.width) || !isNumber(track.height)) {
    return null;
  }

  return {
    protocol: 'generic',
    envelope,
    car: {
      id: 'generic-bot',
      nickname: 'GenericBot',
      position: { x: car.x, y: car.y },
      velocity: { x: car.vx, y: car.vy },
      isOffTrack: false,
    },
    track: normalizeGenericTrack(track),
  };
}

function normalizeGenericTrack(track: Record<string, unknown>): TrackState {
  const width = Math.trunc(track.width as number);
  const height = Math.trunc(track.height as number);
  return {
    id: typeof track.id === 'string' ? track.id : 'generic-track',
    nameKey: typeof track.nameKey === 'string' ? track.nameKey : 'tracks.generic',
    width,
    height,
    grid: Array.from({ length: height }, () => Array.from({ length: width }, () => 'track' as const)),
    startLine: [],
    arrows: [],
  };
}

function toCarState(player: Player): CarState {
  return {
    id: player.connectionId,
    nickname: player.nickname,
    position: { ...player.position },
    velocity: { ...player.velocity },
    isOffTrack: player.isOffTrack,
    passedCheckpoint: player.passedCheckpoint,
    finishOrder: player.finishOrder,
  };
}

function isGameStateShape(value: unknown): value is GameState {
  if (!isObject(value)) return false;
  return (
    typeof value.phase === 'string' &&
    Array.isArray(value.players) &&
    typeof value.trackId === 'string' &&
    Array.isArray(value.turnOrder) &&
    isNumber(value.currentTurnIndex)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
