import {
  GameState,
  Player,
  RelayPayload,
  WsEnvelope,
  canPlayerMove,
  isGearLimited,
} from '../../shared/ws-types';

/** Car kinematics extracted from a Player record. */
export interface CarState {
  position: { x: number; y: number };
  velocity: { x: number; y: number };
  isOffTrack: boolean;
}

/** Minimal track context the brain needs for move filtering. */
export interface TrackState {
  trackId: string;
  width: number;
  height: number;
}

/** Parsed inbound turn context after a RELAY broadcast. */
export interface TurnContext {
  gameState: GameState;
  myPlayer: Player;
  car: CarState;
  track: TrackState;
  isMyTurn: boolean;
  relayType: string;
}

function toCarState(player: Player, round: number): CarState {
  return {
    position: { ...player.position },
    velocity: { ...player.velocity },
    isOffTrack: isGearLimited(player, round),
  };
}

function toTrackState(state: GameState, trackWidth: number, trackHeight: number): TrackState {
  return {
    trackId: state.trackId,
    width: trackWidth,
    height: trackHeight,
  };
}

/**
 * Parse a server RELAY envelope into structured turn context.
 * Returns null when the message is not a game-state relay we care about.
 */
export function parseRelayEnvelope(
  envelope: WsEnvelope,
  connectionId: string,
  trackWidth: number,
  trackHeight: number
): TurnContext | null {
  if (envelope.action !== 'RELAY') return null;

  const payload = envelope.payload as RelayPayload;
  if (!payload?.state) return null;

  const gameState = payload.state;
  const myPlayer = gameState.players.find((p) => p.connectionId === connectionId);
  if (!myPlayer) return null;

  return {
    gameState,
    myPlayer,
    car: toCarState(myPlayer, gameState.round),
    track: toTrackState(gameState, trackWidth, trackHeight),
    isMyTurn: canPlayerMove(gameState, connectionId),
    relayType: payload.type,
  };
}

/** Extract connectionId from lobby lifecycle events. */
export function extractConnectionId(envelope: WsEnvelope): string | null {
  if (
    envelope.action === 'CONNECTED' ||
    envelope.action === 'ROOM_CREATED' ||
    envelope.action === 'JOIN_PENDING' ||
    envelope.action === 'PLAYER_APPROVED' ||
    envelope.action === 'ROOM_REJOINED'
  ) {
    const payload = envelope.payload as { connectionId?: string };
    return payload.connectionId ?? null;
  }
  return null;
}
