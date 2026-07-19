import { APIGatewayProxyHandler } from 'aws-lambda';
import {
  broadcastToApproved,
  broadcastToRoom,
  deleteConnection,
  deleteGhost,
  generateRoomCode,
  getApprovedConnections,
  getConnection,
  getGhost,
  getHostConnection,
  getRoomConnections,
  MAX_PLAYERS,
  nextPlayerColor,
  nicknameTaken,
  putConnection,
  roomCodeExists,
  sendToConnection,
  toPlayer,
  ttl24h,
} from './lib/ddb';
import { ok, parseBody, WsEnvelope } from './lib/response';
import { applyRaceStatDeltas, getTop10, RaceStatDelta } from './lib/leaderboard';

async function isHost(connectionId: string): Promise<boolean> {
  const conn = await getConnection(connectionId);
  return conn?.isHost === true;
}

async function nextJoinOrder(roomCode: string): Promise<number> {
  const approved = await getApprovedConnections(roomCode);
  if (approved.length === 0) return 0;
  return Math.max(...approved.map((c) => c.joinOrder)) + 1;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  const connectionId = event.requestContext.connectionId!;
  const body = parseBody<WsEnvelope>(event);

  if (!body?.action) {
    return ok();
  }

  const { action, payload, roomCode: envelopeRoomCode } = body;

  try {
    switch (action) {
      case 'CREATE_ROOM': {
        const { nickname } = payload as { nickname: string };
        if (!nickname?.trim()) {
          await sendToConnection(connectionId, {
            action: 'ERROR',
            payload: { message: 'Nickname required' },
          });
          return ok();
        }

        let roomCode = generateRoomCode();
        let attempts = 0;
        while ((await roomCodeExists(roomCode)) && attempts < 10) {
          roomCode = generateRoomCode();
          attempts++;
        }

        const color = PLAYER_COLOR_HOST;
        await putConnection({
          connectionId,
          roomCode,
          nickname: nickname.trim(),
          color,
          isHost: true,
          joinOrder: 0,
          status: 'approved',
          ttl: ttl24h(),
        });

        await sendToConnection(connectionId, {
          action: 'ROOM_CREATED',
          payload: {
            roomCode,
            connectionId,
            nickname: nickname.trim(),
            isHost: true,
            color,
          },
          roomCode,
        });
        break;
      }

      case 'JOIN_ROOM': {
        const { nickname, roomCode } = payload as { nickname: string; roomCode: string };
        const code = (roomCode || envelopeRoomCode || '').toUpperCase().trim();

        if (!nickname?.trim() || code.length !== 5) {
          await sendToConnection(connectionId, {
            action: 'ERROR',
            payload: { message: 'Invalid nickname or room code' },
          });
          return ok();
        }

        const host = await getHostConnection(code);
        if (!host) {
          await sendToConnection(connectionId, {
            action: 'ERROR',
            payload: { message: 'Room not found' },
          });
          return ok();
        }

        const approved = await getApprovedConnections(code);
        const pending = (await getRoomConnections(code)).filter((c) => c.status === 'pending');
        if (approved.length + pending.length >= MAX_PLAYERS) {
          await sendToConnection(connectionId, {
            action: 'ERROR',
            payload: { message: 'Room is full' },
          });
          return ok();
        }

        if (await nicknameTaken(code, nickname.trim())) {
          await sendToConnection(connectionId, {
            action: 'ERROR',
            payload: { message: 'Nickname already taken' },
          });
          return ok();
        }

        const color = await nextPlayerColor(code);
        await putConnection({
          connectionId,
          roomCode: code,
          nickname: nickname.trim(),
          color,
          isHost: false,
          joinOrder: -1,
          status: 'pending',
          ttl: ttl24h(),
        });

        await sendToConnection(connectionId, {
          action: 'JOIN_PENDING',
          payload: { roomCode: code, connectionId, nickname: nickname.trim(), color },
          roomCode: code,
        });

        await sendToConnection(host.connectionId, {
          action: 'JOIN_PENDING',
          payload: {
            roomCode: code,
            connectionId,
            nickname: nickname.trim(),
            color,
            pending: true,
          },
          roomCode: code,
        });
        break;
      }

      case 'REJOIN_ROOM': {
        const { nickname, roomCode, previousConnectionId } = payload as {
          nickname: string;
          roomCode: string;
          previousConnectionId?: string;
        };
        const code = (roomCode || envelopeRoomCode || '').toUpperCase().trim();

        if (!nickname?.trim() || code.length !== 5) {
          await sendToConnection(connectionId, {
            action: 'ERROR',
            payload: { message: 'Invalid nickname or room code' },
          });
          return ok();
        }

        const ghost = await getGhost(code, nickname.trim());
        if (!ghost) {
          await sendToConnection(connectionId, {
            action: 'ERROR',
            payload: { message: 'Session expired — join the room again' },
          });
          return ok();
        }

        if (
          previousConnectionId &&
          ghost.previousConnectionId &&
          ghost.previousConnectionId !== previousConnectionId
        ) {
          await sendToConnection(connectionId, {
            action: 'ERROR',
            payload: { message: 'Session expired — join the room again' },
          });
          return ok();
        }

        const currentHost = await getHostConnection(code);
        let isHostFlag = false;
        if (currentHost) {
          isHostFlag = currentHost.connectionId === ghost.previousConnectionId;
        } else if (ghost.wasHost && ghost.status === 'approved') {
          isHostFlag = true;
        }

        if (!currentHost && !isHostFlag) {
          await sendToConnection(connectionId, {
            action: 'ERROR',
            payload: { message: 'Room not found' },
          });
          return ok();
        }

        if (await nicknameTaken(code, nickname.trim())) {
          await sendToConnection(connectionId, {
            action: 'ERROR',
            payload: { message: 'Nickname already taken' },
          });
          return ok();
        }

        await putConnection({
          connectionId,
          roomCode: code,
          nickname: nickname.trim(),
          color: ghost.color,
          isHost: isHostFlag,
          joinOrder: ghost.joinOrder,
          status: ghost.status,
          ttl: ttl24h(),
        });

        await deleteGhost(code, nickname.trim());

        const approved = await getApprovedConnections(code);
        const pending = (await getRoomConnections(code)).filter((c) => c.status === 'pending');

        await sendToConnection(connectionId, {
          action: 'ROOM_REJOINED',
          payload: {
            roomCode: code,
            connectionId,
            nickname: nickname.trim(),
            isHost: isHostFlag,
            players: approved.map(toPlayer),
            pending: pending.map(toPlayer),
          },
          roomCode: code,
        });

        if (ghost.status === 'approved') {
          await broadcastToApproved(
            code,
            {
              action: 'PLAYER_REJOINED',
              payload: {
                oldConnectionId: ghost.previousConnectionId ?? previousConnectionId,
                newConnectionId: connectionId,
                player: toPlayer({
                  connectionId,
                  roomCode: code,
                  nickname: nickname.trim(),
                  color: ghost.color,
                  isHost: isHostFlag,
                  joinOrder: ghost.joinOrder,
                  status: 'approved',
                  ttl: ttl24h(),
                }),
              },
              roomCode: code,
            },
            connectionId
          );
        } else {
          const host = (await getHostConnection(code))!;
          await sendToConnection(host.connectionId, {
            action: 'JOIN_PENDING',
            payload: {
              roomCode: code,
              connectionId,
              nickname: nickname.trim(),
              color: ghost.color,
              pending: true,
            },
            roomCode: code,
          });
        }
        break;
      }

      case 'APPROVE_PLAYER': {
        if (!(await isHost(connectionId))) {
          await sendToConnection(connectionId, {
            action: 'ERROR',
            payload: { message: 'Only host can approve' },
          });
          return ok();
        }

        const hostConn = await getConnection(connectionId);
        const { targetConnectionId } = payload as { targetConnectionId: string };
        const target = await getConnection(targetConnectionId);

        if (!hostConn || !target || target.roomCode !== hostConn.roomCode) {
          return ok();
        }

        const order = await nextJoinOrder(hostConn.roomCode);
        await putConnection({
          ...target,
          status: 'approved',
          joinOrder: order,
          ttl: ttl24h(),
        });

        // Include the full approved roster so the newly approved player
        // (and everyone else) converges on the same player list.
        const roster = (await getApprovedConnections(hostConn.roomCode)).map(toPlayer);

        const approvedPayload = {
          connectionId: target.connectionId,
          nickname: target.nickname,
          color: target.color,
          joinOrder: order,
          isHost: false,
          status: 'approved' as const,
          players: roster,
        };

        await broadcastToApproved(hostConn.roomCode, {
          action: 'PLAYER_APPROVED',
          payload: approvedPayload,
          roomCode: hostConn.roomCode,
        });
        break;
      }

      case 'REJECT_PLAYER': {
        if (!(await isHost(connectionId))) {
          return ok();
        }

        const hostConn = await getConnection(connectionId);
        const { targetConnectionId } = payload as { targetConnectionId: string };
        const target = await getConnection(targetConnectionId);

        if (!hostConn || !target || target.roomCode !== hostConn.roomCode) {
          return ok();
        }

        await deleteConnection(targetConnectionId);
        await sendToConnection(targetConnectionId, {
          action: 'JOIN_REJECTED',
          payload: { message: 'Host rejected your join request' },
        });
        await broadcastToRoom(
          hostConn.roomCode,
          {
            action: 'PLAYER_REJECTED',
            payload: { connectionId: targetConnectionId },
            roomCode: hostConn.roomCode,
          },
          targetConnectionId
        );
        break;
      }

      case 'RELAY': {
        if (!(await isHost(connectionId))) {
          await sendToConnection(connectionId, {
            action: 'ERROR',
            payload: { message: 'Only host can relay game state' },
          });
          return ok();
        }

        const hostConn = await getConnection(connectionId);
        if (!hostConn) return ok();

        const relayPayload = payload as {
          type?: string;
          meta?: { telemetry?: unknown };
        };
        if (relayPayload.meta?.telemetry) {
          console.log(
            JSON.stringify({
              event: 'race_telemetry',
              roomCode: hostConn.roomCode,
              relayType: relayPayload.type,
              telemetry: relayPayload.meta.telemetry,
            })
          );
        }

        await broadcastToApproved(
          hostConn.roomCode,
          {
            action: 'RELAY',
            payload,
            roomCode: hostConn.roomCode,
          },
          connectionId
        );
        break;
      }

      case 'REQUEST_HOST_STATE': {
        const requester = await getConnection(connectionId);
        if (!requester || !requester.isHost) return ok();

        await broadcastToApproved(
          requester.roomCode,
          {
            action: 'REQUEST_HOST_STATE',
            payload: { requesterId: connectionId },
            roomCode: requester.roomCode,
          },
          connectionId
        );
        break;
      }

      case 'HOST_STATE_RESPONSE': {
        const responder = await getConnection(connectionId);
        const { targetHostId, state } = payload as {
          targetHostId: string;
          state: unknown;
        };

        if (!responder || responder.connectionId === targetHostId) return ok();

        // Only deliver snapshots to the room's actual current host — prevents
        // a malicious peer from injecting state into arbitrary connections.
        const roomHost = await getHostConnection(responder.roomCode);
        if (!roomHost || roomHost.connectionId !== targetHostId) return ok();

        await sendToConnection(targetHostId, {
          action: 'HOST_STATE_RESPONSE',
          payload: { state, fromId: connectionId },
          roomCode: responder.roomCode,
        });
        break;
      }

      case 'FORWARD_TO_HOST': {
        const sender = await getConnection(connectionId);
        if (!sender || sender.status !== 'approved') return ok();

        const host = await getHostConnection(sender.roomCode);
        if (!host || host.connectionId === connectionId) return ok();

        // Spread the client payload FIRST so senderId/senderNickname can never
        // be spoofed by a malicious client — the server-side identity wins.
        await sendToConnection(host.connectionId, {
          action: 'PLAYER_ACTION',
          payload: {
            ...(payload as Record<string, unknown>),
            senderId: connectionId,
            senderNickname: sender.nickname,
          },
          roomCode: sender.roomCode,
        });
        break;
      }

      case 'SUBMIT_RACE_STATS': {
        // Host-trusted: same model as RELAY. Counters are clamped to +1 per player.
        if (!(await isHost(connectionId))) return ok();
        const { stats } = (payload ?? {}) as { stats?: RaceStatDelta[] };
        if (!Array.isArray(stats) || stats.length === 0) return ok();
        const applied = await applyRaceStatDeltas(stats);
        await sendToConnection(connectionId, {
          action: 'RACE_STATS_SAVED',
          payload: { applied },
        });
        break;
      }

      case 'GET_TOP10': {
        const entries = await getTop10();
        await sendToConnection(connectionId, {
          action: 'TOP10',
          payload: { entries },
        });
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error('Message handler error', err);
    await sendToConnection(connectionId, {
      action: 'ERROR',
      payload: { message: 'Internal server error' },
    });
  }

  return ok();
};

const PLAYER_COLOR_HOST = '#EF4444';
