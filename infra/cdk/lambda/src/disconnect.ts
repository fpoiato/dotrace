import { APIGatewayProxyHandler } from 'aws-lambda';
import {
  broadcastToRoom,
  deleteConnection,
  getAiHandoffMarker,
  getApprovedConnections,
  getConnection,
  promoteNextHost,
  saveGhost,
  stopAndDeleteAiSeats,
} from './lib/ddb';
import { isHumanConnection, roomHasHuman } from './lib/ai-lifecycle';
import { ok } from './lib/response';

export const handler: APIGatewayProxyHandler = async (event) => {
  const connectionId = event.requestContext.connectionId!;

  const record = await getConnection(connectionId);
  if (!record) {
    return ok();
  }

  const { roomCode, isHost } = record;
  const handoff = await getAiHandoffMarker(roomCode, record.nickname);
  const plannedHandoff = handoff?.previousConnectionId === connectionId;

  if (record.status === 'approved' || record.status === 'pending') {
    await saveGhost(record);
  }

  await deleteConnection(connectionId);

  // Planned AI Lambda rotation (legacy workers during deploy): keep the car
  // in the race. New workers never set this marker.
  if (plannedHandoff) {
    return ok();
  }

  if (isHost) {
    const newHost = await promoteNextHost(roomCode, connectionId);
    if (newHost) {
      await broadcastToRoom(roomCode, {
        action: 'HOST_CHANGED',
        payload: {
          newHostId: newHost.connectionId,
          newHostNickname: newHost.nickname,
          previousHostId: connectionId,
        },
        roomCode,
      });
    }
  } else if (record.status === 'approved') {
    await broadcastToRoom(
      roomCode,
      {
        action: 'PLAYER_LEFT',
        payload: { connectionId, nickname: record.nickname },
        roomCode,
      },
      connectionId
    );
  }

  // Last human left → stop every AI seat so in-flight workers exit and no
  // RELAY can spawn replacements. AI seats are never promoted to host.
  const remaining = await getApprovedConnections(roomCode);
  if (isHumanConnection(record) && !roomHasHuman(remaining)) {
    const stopped = await stopAndDeleteAiSeats(roomCode);
    console.log(`[AI] Last human left room ${roomCode}; stopped ${stopped} AI seat(s)`);
  }

  return ok();
};
