/**
 * index.ts — Dot Race agentive bot entry point.
 *
 * ─── What this bot does ───────────────────────────────────────────────────────
 *
 *   1. Connects to the game server WebSocket.
 *   2. Sends JOIN_ROOM so a human host can approve it via the lobby UI.
 *   3. Listens for RELAY events; when the authoritative state says it is our
 *      turn, delegates to BotBrain.computeNextMove() for pathfinding.
 *   4. Sends the chosen velocity back via FORWARD_TO_HOST → SUBMIT_MOVE so
 *      the host validates and applies the move.
 *   5. On disconnect, stores the previous connectionId and attempts REJOIN_ROOM
 *      so mid-race reconnects preserve the bot's position on the track.
 *
 * ─── Configuration (environment variables) ───────────────────────────────────
 *
 *   WS_URL        WebSocket server URL  (default: ws://localhost:8080/game)
 *   ROOM_CODE     5-letter room code to join             (REQUIRED)
 *   NICKNAME      Display name shown in the lobby         (default: RacerBot)
 *   MOVE_DELAY_MS Milliseconds between deciding and sending a move (default: 500)
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 *   ROOM_CODE=ABCDE npm start
 *   ROOM_CODE=ABCDE NICKNAME=HAL WS_URL=wss://dotrace.example.com/game npm start
 *
 * ─── Message protocol cheat-sheet ────────────────────────────────────────────
 *
 *   All messages are JSON objects shaped as WsEnvelope:
 *     { action: string, payload: unknown, roomCode?: string }
 *
 *   Bot → Server
 *     JOIN_ROOM        { nickname, roomCode }
 *     REJOIN_ROOM      { nickname, roomCode, previousConnectionId }
 *     FORWARD_TO_HOST  { action: "SUBMIT_MOVE", vector: { x, y } }
 *
 *   Server → Bot
 *     JOIN_PENDING     { connectionId, roomCode, … }        (awaiting host approval)
 *     PLAYER_APPROVED  { connectionId, … }                  (we're in!)
 *     JOIN_REJECTED    { message }                          (host rejected us)
 *     ROOM_REJOINED    { connectionId, roomCode, … }        (reconnect success)
 *     RELAY            { type, state: GameState, meta? }    (authoritative snapshot)
 *     PLAYER_LEFT      { connectionId }
 *     HOST_CHANGED     { newHostId, previousHostId? }
 *     ERROR            { message }
 */

import { Connection } from './src/connection';
import { parseRelayPayload } from './src/stateParser';
import { BotBrain } from './src/botBrain';
import type { Vector2D } from '../shared/ws-types';

// ─── Configuration ────────────────────────────────────────────────────────────

const WS_URL = process.env['WS_URL'] ?? 'ws://localhost:8080/game';
const ROOM_CODE = (process.env['ROOM_CODE'] ?? '').toUpperCase().trim();
const NICKNAME = process.env['NICKNAME'] ?? 'RacerBot';
const MOVE_DELAY_MS = Math.max(0, parseInt(process.env['MOVE_DELAY_MS'] ?? '500', 10));

if (!ROOM_CODE || ROOM_CODE.length !== 5) {
  console.error('[CONFIG] ROOM_CODE must be a 5-letter room code.');
  console.error('  Usage: ROOM_CODE=ABCDE npm start');
  process.exit(1);
}

// ─── Bot state ────────────────────────────────────────────────────────────────

/** connectionId assigned to us by the server (set on JOIN_PENDING). */
let myConnectionId: string | null = null;
/** connectionId from the previous session, used for REJOIN_ROOM. */
let previousConnectionId: string | null = null;
/** Room code confirmed by the server (may differ in case from user input). */
let confirmedRoomCode: string | null = null;
/** True once the host has approved us — gates REJOIN attempts on reconnect. */
let wasApproved = false;
/**
 * Prevents the bot from submitting a second move while one is already pending
 * (e.g. rapid RELAY events in TIMED mode).
 */
let movePending = false;

// ─── Modules ──────────────────────────────────────────────────────────────────

const conn = new Connection(WS_URL);
const brain = new BotBrain();

// ─── Message router ───────────────────────────────────────────────────────────

conn.onMessage((envelope) => {
  const action = envelope['action'] as string;
  const payload = (envelope['payload'] ?? {}) as Record<string, unknown>;

  switch (action) {
    // ── Lobby phase ──────────────────────────────────────────────────────────

    case 'JOIN_PENDING': {
      // Server registered our join request; we now know our connectionId.
      // The human host still needs to press "Approve" in the lobby UI.
      const { connectionId, roomCode } = payload as {
        connectionId: string;
        roomCode: string;
      };
      myConnectionId = connectionId;
      confirmedRoomCode = roomCode;
      console.log(
        `[JOIN_PENDING] Waiting for host approval` +
          ` (connectionId=${connectionId}, roomCode=${roomCode})`
      );
      break;
    }

    case 'PLAYER_APPROVED': {
      // Broadcasts to the whole room; only act if it's our own approval.
      const { connectionId } = payload as { connectionId: string };
      if (connectionId === myConnectionId) {
        wasApproved = true;
        console.log('[PLAYER_APPROVED] ✓ Host approved — ready to race!');
      }
      break;
    }

    case 'JOIN_REJECTED': {
      const { message } = payload as { message?: string };
      console.error(`[JOIN_REJECTED] ${message ?? 'No reason given'} — exiting`);
      process.exit(1);
      break;
    }

    case 'ROOM_REJOINED': {
      // Reconnect succeeded; update our connectionId for the new session.
      const { connectionId, roomCode } = payload as {
        connectionId: string;
        roomCode: string;
      };
      myConnectionId = connectionId;
      confirmedRoomCode = roomCode;
      wasApproved = true;
      movePending = false;
      console.log(`[ROOM_REJOINED] Reconnected as connectionId=${connectionId}`);
      break;
    }

    // ── Racing phase ─────────────────────────────────────────────────────────

    case 'RELAY': {
      handleRelay(payload);
      break;
    }

    // ── Informational / housekeeping ─────────────────────────────────────────

    case 'PLAYER_LEFT': {
      const { connectionId } = payload as { connectionId?: string };
      if (connectionId) console.log(`[PLAYER_LEFT] connectionId=${connectionId}`);
      break;
    }

    case 'HOST_CHANGED': {
      const { newHostId } = payload as { newHostId?: string };
      console.log(`[HOST_CHANGED] New host: ${newHostId ?? 'unknown'}`);
      break;
    }

    case 'GAME_OVER': {
      console.log('[GAME_OVER] Race finished — bot will idle until the process exits');
      break;
    }

    case 'ERROR': {
      const { message } = payload as { message?: string };
      console.error(`[SERVER ERROR] ${message ?? 'unknown error'}`);
      break;
    }

    default:
      break;
  }
});

// ─── RELAY handler ────────────────────────────────────────────────────────────

function handleRelay(payload: Record<string, unknown>): void {
  if (!myConnectionId) return;
  // Prevent a second move being queued while the first is still deliberating.
  if (movePending) return;

  const turn = parseRelayPayload(payload, myConnectionId);
  if (!turn) return; // Not our turn, or game not in GAME_ROUND phase.

  movePending = true;
  const { myPlayer, track, otherPlayers } = turn;

  // Small deliberation delay — makes the bot feel less instant and avoids
  // hammering the server on rapid RELAY bursts in TIMED mode.
  setTimeout(() => {
    try {
      const velocity: Vector2D = brain.computeNextMove(myPlayer, track, otherPlayers);
      submitMove(velocity);
    } finally {
      movePending = false;
    }
  }, MOVE_DELAY_MS);
}

// ─── Move submission ──────────────────────────────────────────────────────────

/**
 * Wrap the chosen velocity in the FORWARD_TO_HOST envelope and send it.
 *
 * Wire format:
 *   {
 *     action: "FORWARD_TO_HOST",
 *     payload: { action: "SUBMIT_MOVE", vector: { x: number, y: number } },
 *     roomCode: string
 *   }
 *
 * The server strips FORWARD_TO_HOST, appends senderId/senderNickname, and
 * delivers a PLAYER_ACTION to the host.  The host's GameEngineService then
 * calls applyMove() to validate the vector and update the authoritative state.
 */
function submitMove(velocity: Vector2D): void {
  const roomCode = confirmedRoomCode;
  if (!roomCode) {
    console.warn('[SUBMIT_MOVE] No confirmed roomCode yet — dropping move');
    return;
  }
  console.log(`[SUBMIT_MOVE] vector=(${velocity.x},${velocity.y})`);
  conn.send('FORWARD_TO_HOST', { action: 'SUBMIT_MOVE', vector: velocity }, roomCode);
}

// ─── Connection lifecycle ─────────────────────────────────────────────────────

conn.on('connected', () => {
  movePending = false;

  if (wasApproved && myConnectionId && confirmedRoomCode) {
    // Mid-race reconnect: attempt to rejoin with the previous connectionId so
    // the host preserves our position, velocity, and trail on the track.
    console.log(`[BOT] Rejoining room ${confirmedRoomCode} as "${NICKNAME}"…`);
    previousConnectionId = myConnectionId;
    myConnectionId = null; // Will be reassigned via ROOM_REJOINED.
    conn.send('REJOIN_ROOM', {
      nickname: NICKNAME,
      roomCode: confirmedRoomCode,
      previousConnectionId,
    });
  } else {
    // First connection or post-rejection: join fresh.
    console.log(`[BOT] Joining room ${ROOM_CODE} as "${NICKNAME}"…`);
    conn.send('JOIN_ROOM', { nickname: NICKNAME, roomCode: ROOM_CODE });
  }
});

conn.on('disconnected', () => {
  // Keep myConnectionId and confirmedRoomCode so a reconnect can attempt
  // REJOIN_ROOM.  The reconnect itself is handled by Connection.scheduleReconnect().
  console.log('[BOT] Connection lost — reconnect scheduled');
});

conn.on('error', () => {
  console.error('[BOT] Socket error occurred');
});

// ─── Start ────────────────────────────────────────────────────────────────────

console.log('─'.repeat(60));
console.log(' Dot Race — Agentive Bot');
console.log('─'.repeat(60));
console.log(` Server:       ${WS_URL}`);
console.log(` Room:         ${ROOM_CODE}`);
console.log(` Nickname:     ${NICKNAME}`);
console.log(` Move delay:   ${MOVE_DELAY_MS}ms`);
console.log('─'.repeat(60));

conn.connect().catch((err: Error) => {
  // The Connection class has already scheduled a reconnect; just log here.
  // process.exit only if the server URL itself is clearly wrong (no port, bad hostname, …).
  console.warn('[WARN] Initial connection attempt failed:', err.message);
  console.log('[BOT] Reconnect already scheduled — will keep retrying');
});
