import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  broadcastToApproved,
  broadcastToRoom,
  consumeAiMarker,
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
  putAiMarker,
  putConnection,
  roomCodeExists,
  sendToConnection,
  toPlayer,
  ttl24h,
} from './ddb';
import { applyRaceStatDeltas, getTop10, RaceStatDelta } from './leaderboard';
import { WsEnvelope } from './response';

const PLAYER_COLOR_HOST = '#EF4444';

const lambdaClient = new LambdaClient({});

export interface ActionResult {
  /** Envelope the caller would receive on their socket (returned inline for HTTP). */
  response?: WsEnvelope;
}

async function isHost(connectionId: string): Promise<boolean> {
  const conn = await getConnection(connectionId);
  return conn?.isHost === true;
}

async function nextJoinOrder(roomCode: string): Promise<number> {
  const approved = await getApprovedConnections(roomCode);
  if (approved.length === 0) return 0;
  return Math.max(...approved.map((c) => c.joinOrder)) + 1;
}

/** Deliver a reply to the acting connection over WebSocket (push channel). */
async function replyToCaller(
  connectionId: string,
  envelope: WsEnvelope,
  result: ActionResult,
  pushToCaller: boolean
): Promise<void> {
  result.response = envelope;
  if (pushToCaller) {
    await sendToConnection(connectionId, envelope);
  }
}

/**
 * Shared game/room action handler used by both the WebSocket `$default` route
 * and the HTTP API. When `pushToCaller` is false (HTTP), the caller's reply is
 * returned in `ActionResult.response` instead of being posted to their socket;
 * peer notifications still go over WebSocket.
 */
export async function handleClientAction(
  connectionId: string,
  body: WsEnvelope,
  options: { pushToCaller?: boolean } = {}
): Promise<ActionResult> {
  const pushToCaller = options.pushToCaller !== false;
  const result: ActionResult = {};
  const { action, payload, roomCode: envelopeRoomCode } = body;

  if (!action) {
    return result;
  }

  switch (action) {
    case 'HELLO': {
      await replyToCaller(
        connectionId,
        { action: 'CONNECTED', payload: { connectionId } },
        result,
        pushToCaller
      );
      break;
    }

    case 'PING': {
      await replyToCaller(
        connectionId,
        { action: 'PONG', payload: { ts: Date.now() } },
        result,
        pushToCaller
      );
      break;
    }

    case 'CREATE_ROOM': {
      const { nickname } = (payload ?? {}) as { nickname: string };
      if (!nickname?.trim()) {
        await replyToCaller(
          connectionId,
          { action: 'ERROR', payload: { message: 'Nickname required' } },
          result,
          pushToCaller
        );
        break;
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

      await replyToCaller(
        connectionId,
        {
          action: 'ROOM_CREATED',
          payload: {
            roomCode,
            connectionId,
            nickname: nickname.trim(),
            isHost: true,
            color,
          },
          roomCode,
        },
        result,
        pushToCaller
      );
      break;
    }

    case 'JOIN_ROOM': {
      const { nickname, roomCode } = (payload ?? {}) as { nickname: string; roomCode: string };
      const code = (roomCode || envelopeRoomCode || '').toUpperCase().trim();

      if (!nickname?.trim() || code.length !== 5) {
        await replyToCaller(
          connectionId,
          { action: 'ERROR', payload: { message: 'Invalid nickname or room code' } },
          result,
          pushToCaller
        );
        break;
      }

      const host = await getHostConnection(code);
      if (!host) {
        await replyToCaller(
          connectionId,
          { action: 'ERROR', payload: { message: 'Room not found' } },
          result,
          pushToCaller
        );
        break;
      }

      const approved = await getApprovedConnections(code);
      const pending = (await getRoomConnections(code)).filter((c) => c.status === 'pending');
      if (approved.length + pending.length >= MAX_PLAYERS) {
        await replyToCaller(
          connectionId,
          { action: 'ERROR', payload: { message: 'Room is full' } },
          result,
          pushToCaller
        );
        break;
      }

      if (await nicknameTaken(code, nickname.trim())) {
        await replyToCaller(
          connectionId,
          { action: 'ERROR', payload: { message: 'Nickname already taken' } },
          result,
          pushToCaller
        );
        break;
      }

      const color = await nextPlayerColor(code);

      // Host-requested AI players skip the approval queue: the SPAWN_AI_PLAYER
      // action left a marker, so approve on join and broadcast the roster.
      if (await consumeAiMarker(code, nickname.trim())) {
        const order = await nextJoinOrder(code);
        await putConnection({
          connectionId,
          roomCode: code,
          nickname: nickname.trim(),
          color,
          isHost: false,
          joinOrder: order,
          status: 'approved',
          ttl: ttl24h(),
        });

        const roster = (await getApprovedConnections(code)).map(toPlayer);
        const approvedEnvelope: WsEnvelope = {
          action: 'PLAYER_APPROVED',
          payload: {
            connectionId,
            nickname: nickname.trim(),
            color,
            joinOrder: order,
            isHost: false,
            status: 'approved' as const,
            players: roster,
          },
          roomCode: code,
        };
        // Reply with PLAYER_APPROVED (not JOIN_PENDING) so the AI client's HTTP
        // response alone marks it approved — avoids a WS/HTTP race that left
        // the pilot stuck waiting for approval and never taking its turn.
        await replyToCaller(connectionId, approvedEnvelope, result, pushToCaller);
        await broadcastToApproved(code, approvedEnvelope, connectionId);
        break;
      }

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

      await replyToCaller(
        connectionId,
        {
          action: 'JOIN_PENDING',
          payload: { roomCode: code, connectionId, nickname: nickname.trim(), color },
          roomCode: code,
        },
        result,
        pushToCaller
      );

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
      const { nickname, roomCode, previousConnectionId } = (payload ?? {}) as {
        nickname: string;
        roomCode: string;
        previousConnectionId?: string;
      };
      const code = (roomCode || envelopeRoomCode || '').toUpperCase().trim();

      if (!nickname?.trim() || code.length !== 5) {
        await replyToCaller(
          connectionId,
          { action: 'ERROR', payload: { message: 'Invalid nickname or room code' } },
          result,
          pushToCaller
        );
        break;
      }

      const ghost = await getGhost(code, nickname.trim());
      if (!ghost) {
        await replyToCaller(
          connectionId,
          { action: 'ERROR', payload: { message: 'Session expired — join the room again' } },
          result,
          pushToCaller
        );
        break;
      }

      if (
        previousConnectionId &&
        ghost.previousConnectionId &&
        ghost.previousConnectionId !== previousConnectionId
      ) {
        await replyToCaller(
          connectionId,
          { action: 'ERROR', payload: { message: 'Session expired — join the room again' } },
          result,
          pushToCaller
        );
        break;
      }

      const currentHost = await getHostConnection(code);
      let isHostFlag = false;
      if (currentHost) {
        isHostFlag = currentHost.connectionId === ghost.previousConnectionId;
      } else if (ghost.wasHost && ghost.status === 'approved') {
        isHostFlag = true;
      }

      if (!currentHost && !isHostFlag) {
        await replyToCaller(
          connectionId,
          { action: 'ERROR', payload: { message: 'Room not found' } },
          result,
          pushToCaller
        );
        break;
      }

      if (await nicknameTaken(code, nickname.trim())) {
        await replyToCaller(
          connectionId,
          { action: 'ERROR', payload: { message: 'Nickname already taken' } },
          result,
          pushToCaller
        );
        break;
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

      await replyToCaller(
        connectionId,
        {
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
        },
        result,
        pushToCaller
      );

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
        await replyToCaller(
          connectionId,
          { action: 'ERROR', payload: { message: 'Only host can approve' } },
          result,
          pushToCaller
        );
        break;
      }

      const hostConn = await getConnection(connectionId);
      const { targetConnectionId } = (payload ?? {}) as { targetConnectionId: string };
      const target = await getConnection(targetConnectionId);

      if (!hostConn || !target || target.roomCode !== hostConn.roomCode) {
        break;
      }

      const order = await nextJoinOrder(hostConn.roomCode);
      await putConnection({
        ...target,
        status: 'approved',
        joinOrder: order,
        ttl: ttl24h(),
      });

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

      const envelope: WsEnvelope = {
        action: 'PLAYER_APPROVED',
        payload: approvedPayload,
        roomCode: hostConn.roomCode,
      };
      result.response = envelope;
      await broadcastToApproved(hostConn.roomCode, envelope);
      break;
    }

    case 'REJECT_PLAYER': {
      if (!(await isHost(connectionId))) {
        break;
      }

      const hostConn = await getConnection(connectionId);
      const { targetConnectionId } = (payload ?? {}) as { targetConnectionId: string };
      const target = await getConnection(targetConnectionId);

      if (!hostConn || !target || target.roomCode !== hostConn.roomCode) {
        break;
      }

      await deleteConnection(targetConnectionId);
      await sendToConnection(targetConnectionId, {
        action: 'JOIN_REJECTED',
        payload: { message: 'Host rejected your join request' },
      });
      const envelope: WsEnvelope = {
        action: 'PLAYER_REJECTED',
        payload: { connectionId: targetConnectionId },
        roomCode: hostConn.roomCode,
      };
      result.response = envelope;
      await broadcastToRoom(hostConn.roomCode, envelope, targetConnectionId);
      break;
    }

    case 'RELAY': {
      if (!(await isHost(connectionId))) {
        await replyToCaller(
          connectionId,
          { action: 'ERROR', payload: { message: 'Only host can relay game state' } },
          result,
          pushToCaller
        );
        break;
      }

      const hostConn = await getConnection(connectionId);
      if (!hostConn) break;

      const relayPayload = payload as {
        type?: string;
        meta?: { telemetry?: unknown };
      };
      if (relayPayload?.meta?.telemetry) {
        console.log(
          JSON.stringify({
            event: 'race_telemetry',
            roomCode: hostConn.roomCode,
            relayType: relayPayload.type,
            telemetry: relayPayload.meta.telemetry,
          })
        );
      }

      const envelope: WsEnvelope = {
        action: 'RELAY',
        payload,
        roomCode: hostConn.roomCode,
      };
      result.response = { action: 'RELAY_ACK', payload: { ok: true }, roomCode: hostConn.roomCode };
      await broadcastToApproved(hostConn.roomCode, envelope, connectionId);
      break;
    }

    case 'REQUEST_HOST_STATE': {
      const requester = await getConnection(connectionId);
      if (!requester || !requester.isHost) break;

      await broadcastToApproved(
        requester.roomCode,
        {
          action: 'REQUEST_HOST_STATE',
          payload: { requesterId: connectionId },
          roomCode: requester.roomCode,
        },
        connectionId
      );
      result.response = {
        action: 'REQUEST_HOST_STATE',
        payload: { requesterId: connectionId },
        roomCode: requester.roomCode,
      };
      break;
    }

    case 'HOST_STATE_RESPONSE': {
      const responder = await getConnection(connectionId);
      const { targetHostId, state } = (payload ?? {}) as {
        targetHostId: string;
        state: unknown;
      };

      if (!responder || responder.connectionId === targetHostId) break;

      const roomHost = await getHostConnection(responder.roomCode);
      if (!roomHost || roomHost.connectionId !== targetHostId) break;

      await sendToConnection(targetHostId, {
        action: 'HOST_STATE_RESPONSE',
        payload: { state, fromId: connectionId },
        roomCode: responder.roomCode,
      });
      result.response = {
        action: 'HOST_STATE_RESPONSE',
        payload: { delivered: true },
        roomCode: responder.roomCode,
      };
      break;
    }

    case 'FORWARD_TO_HOST': {
      const sender = await getConnection(connectionId);
      if (!sender || sender.status !== 'approved') break;

      const host = await getHostConnection(sender.roomCode);
      if (!host || host.connectionId === connectionId) break;

      await sendToConnection(host.connectionId, {
        action: 'PLAYER_ACTION',
        payload: {
          ...(payload as Record<string, unknown>),
          senderId: connectionId,
          senderNickname: sender.nickname,
        },
        roomCode: sender.roomCode,
      });
      result.response = {
        action: 'FORWARD_ACK',
        payload: { ok: true },
        roomCode: sender.roomCode,
      };
      break;
    }

    case 'SUBMIT_RACE_STATS': {
      if (!(await isHost(connectionId))) break;
      const { stats } = (payload ?? {}) as { stats?: RaceStatDelta[] };
      if (!Array.isArray(stats) || stats.length === 0) break;
      const applied = await applyRaceStatDeltas(stats);
      await replyToCaller(
        connectionId,
        { action: 'RACE_STATS_SAVED', payload: { applied } },
        result,
        pushToCaller
      );
      break;
    }

    case 'GET_TOP10': {
      const entries = await getTop10();
      await replyToCaller(
        connectionId,
        { action: 'TOP10', payload: { entries } },
        result,
        pushToCaller
      );
      break;
    }

    case 'SPAWN_AI_PLAYER': {
      if (!(await isHost(connectionId))) {
        await replyToCaller(
          connectionId,
          { action: 'ERROR', payload: { message: 'Only host can add AI players' } },
          result,
          pushToCaller
        );
        break;
      }

      const hostConn = await getConnection(connectionId);
      if (!hostConn) break;

      const { nickname, brain: brainRaw, difficulty: difficultyRaw } = (payload ?? {}) as {
        nickname?: string;
        brain?: string;
        difficulty?: string;
      };
      const name = nickname?.trim();
      if (!name) {
        await replyToCaller(
          connectionId,
          { action: 'ERROR', payload: { message: 'Nickname required' } },
          result,
          pushToCaller
        );
        break;
      }

      const brain = brainRaw === 'bedrock' ? 'bedrock' : 'heuristic';
      const difficulty =
        difficultyRaw === 'easy' ||
        difficultyRaw === 'medium' ||
        difficultyRaw === 'hard' ||
        difficultyRaw === 'pro'
          ? difficultyRaw
          : 'medium';

      const functionName = process.env.AI_PLAYER_FUNCTION_NAME;
      if (!functionName) {
        await replyToCaller(
          connectionId,
          { action: 'ERROR', payload: { message: 'AI players not available' } },
          result,
          pushToCaller
        );
        break;
      }

      const code = hostConn.roomCode;
      const approved = await getApprovedConnections(code);
      const pending = (await getRoomConnections(code)).filter((c) => c.status === 'pending');
      if (approved.length + pending.length >= MAX_PLAYERS) {
        await replyToCaller(
          connectionId,
          { action: 'ERROR', payload: { message: 'Room is full' } },
          result,
          pushToCaller
        );
        break;
      }

      if (await nicknameTaken(code, name)) {
        await replyToCaller(
          connectionId,
          { action: 'ERROR', payload: { message: 'Nickname already taken' } },
          result,
          pushToCaller
        );
        break;
      }

      await putAiMarker(code, name);
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({ roomCode: code, nickname: name, brain, difficulty })),
        })
      );

      await replyToCaller(
        connectionId,
        {
          action: 'AI_PLAYER_SPAWNING',
          payload: { roomCode: code, nickname: name, brain },
          roomCode: code,
        },
        result,
        pushToCaller
      );
      break;
    }

    default:
      break;
  }

  return result;
}

/** Leaderboard read that does not require a live WebSocket connection. */
export async function fetchTop10Entries() {
  return getTop10();
}
