/**
 * Entry point — wires the three layers together:
 *   SocketClient (transport) → StateStore (inbound parsing) → BotBrain (math)
 * and sends the chosen move back out in the server's wire format.
 *
 * Usage:
 *   BOT_WS_URL=wss://<api-id>.execute-api.us-east-1.amazonaws.com/prod \
 *   BOT_ROOM_CODE=ABCDE \
 *   BOT_NICKNAME=VectorBot \
 *   npm start
 */
import { getTrackById } from '../../shared/tracks';
import { GameState, PlayerGameAction } from '../../shared/ws-types';
import { BotBrain } from './bot-brain';
import { log } from './log';
import { SocketClient } from './socket-client';
import { StateStore } from './state-store';

const WS_URL = process.env.BOT_WS_URL ?? 'ws://localhost:8080/game';
const ROOM_CODE = (process.env.BOT_ROOM_CODE ?? process.argv[2] ?? '').toUpperCase().trim();
const NICKNAME = process.env.BOT_NICKNAME ?? process.argv[3] ?? 'VectorBot';
/** Small human-ish delay before answering a turn, so relays settle. */
const THINK_DELAY_MS = Number(process.env.BOT_THINK_DELAY_MS ?? 400);

async function main(): Promise<void> {
  if (!ROOM_CODE || ROOM_CODE.length !== 5) {
    console.error('Usage: BOT_ROOM_CODE=ABCDE npm start   (or: npm start -- ABCDE [nickname])');
    process.exit(1);
  }

  const socket = new SocketClient(WS_URL);
  const store = new StateStore();
  const brain = new BotBrain();

  socket.onEnvelope((envelope) => store.handleEnvelope(envelope));

  // The API Gateway hands out a fresh connectionId per socket, so after any
  // drop we must REJOIN (not re-JOIN) to keep our car and turn slot.
  socket.onReconnected(() => {
    const room = store.room;
    if (!room) return;
    socket.send(
      'REJOIN_ROOM',
      { nickname: room.nickname, roomCode: room.roomCode, previousConnectionId: room.connectionId },
      room.roomCode
    );
  });

  store.on('approved', () => log('INFO', 'Waiting for the host to start the race…'));
  store.on('rejected', () => {
    socket.close();
    process.exit(1);
  });
  store.on('game-over', (state: GameState) => {
    const podium = state.podium.map((p) => `${p.position}. ${p.nickname}`).join('  ');
    log('INFO', `Race over — podium: ${podium || '(none)'}`);
  });

  // It's our turn: run the brain and ship the move.
  store.on('my-turn', (state: GameState) => {
    const me = store.me;
    const track = getTrackById(state.trackId);
    const room = store.room;
    if (!me || !track || !room) {
      log('ERROR', 'Turn received but car/track/room context is missing — skipping');
      return;
    }

    const move = brain.computeNextMove(me, track, state.players);

    setTimeout(() => {
      // Outbound wire format: non-hosts submit moves via FORWARD_TO_HOST with
      // a PlayerGameAction payload; the host validates and relays new state.
      const action: PlayerGameAction = { action: 'SUBMIT_MOVE', vector: move.velocity };
      socket.send('FORWARD_TO_HOST', action, room.roomCode);
      log(
        'MOVE',
        `Submitted a=(${move.acceleration.dx},${move.acceleration.dy}) as velocity (${move.velocity.x},${move.velocity.y})`
      );
    }, THINK_DELAY_MS);
  });

  await socket.connect();
  socket.send('JOIN_ROOM', { nickname: NICKNAME, roomCode: ROOM_CODE }, ROOM_CODE);
  log('INFO', `Join request sent for room ${ROOM_CODE} as "${NICKNAME}" — approve the bot in the lobby`);

  const shutdown = () => {
    log('INFO', 'Shutting down');
    socket.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log('ERROR', `Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
