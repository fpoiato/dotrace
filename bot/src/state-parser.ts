import {
  GameState,
  Player,
  RelayPayload,
  WsEnvelope,
  canPlayerMove,
} from '../../shared/ws-types';

/** Parsed inbound turn context after a RELAY broadcast. */
export interface TurnContext {
  gameState: GameState;
  myPlayer: Player;
  isMyTurn: boolean;
  relayType: string;
}

/**
 * Parse a server RELAY envelope into structured turn context.
 * Returns null when the message is not a game-state relay we care about.
 */
export function parseRelayEnvelope(
  envelope: WsEnvelope,
  connectionId: string
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
