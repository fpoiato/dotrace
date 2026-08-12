import { APIGatewayProxyHandler } from 'aws-lambda';
import {
  broadcastToRoom,
  deleteConnection,
  getAiHandoffMarker,
  getConnection,
  promoteNextHost,
  saveGhost,
} from './lib/ddb';
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

  // Planned AI Lambda rotation: keep the car in the race; successor rejoins
  // via ghost + PLAYER_REJOINED. Do not emit PLAYER_LEFT.
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

  return ok();
};
