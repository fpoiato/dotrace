/**
 * End-to-end smoke test: spin up a mock server that plays the roles of both
 * the API Gateway relay and the human host's in-browser game engine, then let
 * the bot race a full solo lap on a real track.
 *
 * Pass criteria: the bot joins, gets approved, and finishes the lap within
 * MAX_TURNS moves — exercising join → approval → RELAY parsing → BotBrain →
 * FORWARD_TO_HOST round trips over a real WebSocket.
 */
import { WebSocketServer, WebSocket } from 'ws';
import {
  GameState,
  Player,
  Vector2D,
  WsEnvelope,
  createInitialState,
  createLobbyPlayer,
  getTileAt,
  getValidMoves,
  landingPosition,
  pushTrail,
  segmentCrossesFinish,
  segmentEntersRect,
  zeroVector,
} from '../../shared/ws-types';
import { getTrackById } from '../../shared/tracks';
import { VectorRallyBot } from '../src/bot';
import { loadConfig } from '../src/config';

const PORT = 8931;
const ROOM = 'TESTR';
const TRACK_ID = process.env.TEST_TRACK_ID ?? 'monza';
const MAX_TURNS = 200;

const track = getTrackById(TRACK_ID)!;
let state: GameState;
let botSocket: WebSocket | null = null;
let turns = 0;

function send(socket: WebSocket, envelope: WsEnvelope): void {
  socket.send(JSON.stringify(envelope));
}

function relay(type: string): void {
  if (!botSocket) return;
  send(botSocket, { action: 'RELAY', payload: { type, state }, roomCode: ROOM });
}

/** Host-side move application — same rules as GameEngineService.applyMove. */
function applyMove(player: Player, vector: Vector2D): void {
  const legal = getValidMoves(player, track, state.players).some(
    (m) => m.velocity.x === vector.x && m.velocity.y === vector.y
  );
  if (!legal) {
    console.error(`[TEST] ILLEGAL MOVE rejected: (${vector.x},${vector.y})`);
    return;
  }

  const from = { ...player.position };
  const landing = landingPosition(player.position, vector);
  const tile = getTileAt(track, landing.x, landing.y);
  if (tile === null) return;

  player.position = landing;
  pushTrail(player, landing);

  if (tile === 'grass') {
    player.velocity = zeroVector();
    player.isOffTrack = true;
    console.log(`[TEST] turn ${turns}: landed on GRASS at (${landing.x},${landing.y})`);
  } else {
    player.velocity = { ...vector };
    player.isOffTrack = false;
  }

  if (track.checkpoint && !player.passedCheckpoint) {
    player.passedCheckpoint = segmentEntersRect(from, landing, track.checkpoint);
    if (player.passedCheckpoint) console.log(`[TEST] turn ${turns}: checkpoint passed`);
  }

  if (
    player.passedCheckpoint !== false &&
    segmentCrossesFinish(track, from, landing) &&
    tile !== 'grass'
  ) {
    player.finishOrder = 1;
    state.podium.push({ connectionId: player.connectionId, nickname: player.nickname, position: 1 });
    state.phase = 'GAME_OVER';
    relay('GAME_OVER');
    finish(true);
    return;
  }

  state.round += 1;
  relay('TURN_ADVANCED');
}

function finish(passed: boolean): void {
  console.log(
    passed
      ? `[TEST] PASS — bot finished the lap on '${TRACK_ID}' in ${turns} turns`
      : `[TEST] FAIL — bot did not finish within ${MAX_TURNS} turns`
  );
  bot.stop();
  wss.close();
  process.exit(passed ? 0 : 1);
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (socket) => {
  botSocket = socket;

  socket.on('message', (data) => {
    const envelope = JSON.parse(data.toString()) as WsEnvelope;

    if (envelope.action === 'JOIN_ROOM') {
      const { nickname } = envelope.payload as { nickname: string };
      const botId = 'bot-conn-1';

      // Lobby lifecycle: pending → approved.
      send(socket, {
        action: 'JOIN_PENDING',
        payload: { roomCode: ROOM, connectionId: botId, nickname, color: '#3B82F6' },
        roomCode: ROOM,
      });
      send(socket, {
        action: 'PLAYER_APPROVED',
        payload: { connectionId: botId, nickname, color: '#3B82F6', joinOrder: 1 },
        roomCode: ROOM,
      });

      // Start a solo race immediately (practice-mode flow).
      const botPlayer = createLobbyPlayer(botId, nickname, false, 1, '#3B82F6');
      state = createInitialState([botPlayer], 'host-conn-0');
      state.trackId = TRACK_ID;
      const racer = state.players[0];
      racer.position = { ...track.startLine[0] };
      racer.trail = [{ ...racer.position }];
      racer.passedCheckpoint = false;
      state.turnOrder = [botId];
      state.currentTurnIndex = 0;
      state.phase = 'GAME_ROUND';
      state.raceStartedAt = Date.now();
      relay('GRID_ORDER_DONE');
    }

    if (envelope.action === 'FORWARD_TO_HOST') {
      const payload = envelope.payload as { action: string; vector: Vector2D };
      if (payload.action !== 'SUBMIT_MOVE') return;
      turns++;
      if (turns > MAX_TURNS) {
        finish(false);
        return;
      }
      applyMove(state.players[0], payload.vector);
    }
  });
});

console.log(`[TEST] mock host server listening on ws://localhost:${PORT}, track='${TRACK_ID}'`);

const bot = new VectorRallyBot(
  loadConfig({
    wsUrl: `ws://localhost:${PORT}`,
    roomCode: ROOM,
    nickname: 'TestBot',
    moveDelayMs: 5,
    resubmitAfterMs: 4000,
  })
);
bot.start();

setTimeout(() => finish(false), 60_000);
