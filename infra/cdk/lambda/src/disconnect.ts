import { APIGatewayProxyHandler } from 'aws-lambda';
import {
  broadcastToRoom,
  deleteConnection,
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

  if (record.status === 'approved' || record.status === 'pending') {
    await saveGhost(record);
  }

  await deleteConnection(connectionId);

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
