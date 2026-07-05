import { WebSocketServer, type WebSocket } from 'ws';
import type { GameState, Player, Vector2D, WsEnvelope } from '../../shared/ws-types';
import {
  findCollisionOpponent,
  getTileAt,
  getValidMoves,
  isGameOver,
  landingPosition,
  pushTrail,
  segmentCrossesFinish,
  segmentEntersRect,
  zeroVector,
} from '../../shared/ws-types';
import { getTrackById } from '../../shared/tracks';

/**
 * Minimal stand-in for the Dot Race host + API Gateway, JUST enough to drive a
 * bot through a full solo practice race for local testing. NOT production code.
 *
 *   JOIN_ROOM -> JOIN_PENDING -> PLAYER_APPROVED -> RELAY(GRID_ORDER_DONE)
 *   FORWARD_TO_HOST(SUBMIT_MOVE) -> applyMove -> RELAY(TURN_ADVANCED | GAME_OVER)
 */

const PORT = Number(process.env.PORT ?? 8080);
const TRACK_ID = process.env.MOCK_TRACK_ID ?? 'monza';
const TOTAL_LAPS = Number(process.env.MOCK_TOTAL_LAPS ?? 1);
const MAX_ROUNDS = 400;

const wss = new WebSocketServer({ port: PORT });
console.log(`[MOCK] listening on ws://localhost:${PORT}`);

let seq = 0;

wss.on('connection', (socket: WebSocket) => {
  const connectionId = `mock-${++seq}`;
  let state: GameState | null = null;
  let botId: string | null = null;

  const send = (action: WsEnvelope['action'], payload: unknown) =>
    socket.send(JSON.stringify({ action, payload } satisfies WsEnvelope));

  const relay = (type: string) => send('RELAY', { type, state });

  socket.on('message', (raw) => {
    let env: WsEnvelope;
    try {
      env = JSON.parse(raw.toString()) as WsEnvelope;
    } catch {
      return;
    }

    if (env.action === 'JOIN_ROOM') {
      const { nickname } = env.payload as { nickname: string };
      botId = connectionId;
      send('JOIN_PENDING', { roomCode: 'MOCKR', connectionId: botId, nickname, color: '#3B82F6' });

      setTimeout(() => {
        send('PLAYER_APPROVED', { connectionId: botId, nickname, color: '#3B82F6', joinOrder: 1 });
        state = buildRace(botId!, nickname);
        console.log(`[MOCK] race started on ${TRACK_ID}, ${TOTAL_LAPS} lap(s)`);
        relay('GRID_ORDER_DONE');
      }, 100);
      return;
    }

    if (env.action === 'FORWARD_TO_HOST' && state && botId) {
      const inner = env.payload as { action?: string; vector?: Vector2D };
      if (inner.action !== 'SUBMIT_MOVE' || !inner.vector) return;
      applyMove(state, botId, inner.vector);

      if (isGameOver(state) || state.round > MAX_ROUNDS) {
        state.phase = 'GAME_OVER';
        console.log('[MOCK] game over:', JSON.stringify(state.podium));
        relay('GAME_OVER');
        return;
      }
      relay('TURN_ADVANCED');
    }
  });

  socket.on('close', () => console.log(`[MOCK] ${connectionId} disconnected`));
});

function buildRace(botId: string, nickname: string): GameState {
  const track = getTrackById(TRACK_ID)!;
  const start = track.startLine[0];
  const bot: Player = {
    connectionId: botId,
    nickname,
    color: '#3B82F6',
    isHost: false,
    joinOrder: 1,
    status: 'approved',
    position: { ...start },
    velocity: zeroVector(),
    isOffTrack: false,
    trail: [{ ...start }],
    lap: 1,
    passedCheckpoint: false,
  };
  return {
    phase: 'GAME_ROUND',
    players: [bot],
    hostId: 'mock-host',
    trackId: TRACK_ID,
    turnOrder: [botId],
    currentTurnIndex: 0,
    round: 1,
    totalLaps: TOTAL_LAPS,
    gameMode: 'TURNS',
    diceRolls: {},
    podium: [],
    raceStartedAt: Date.now(),
  };
}

/** Faithful (compact) port of GameEngineService.applyMove for the solo case. */
function applyMove(state: GameState, senderId: string, vector: Vector2D): void {
  const track = getTrackById(state.trackId);
  const player = state.players.find((p) => p.connectionId === senderId);
  if (!track || !player) return;

  const legal = getValidMoves(player, track, state.players).some(
    (m) => m.velocity.x === vector.x && m.velocity.y === vector.y
  );
  if (!legal) {
    console.log('[MOCK] rejected illegal move', vector);
    return;
  }

  const from = { ...player.position };
  const landing = landingPosition(player.position, vector);

  if (findCollisionOpponent(senderId, from, landing, state.players)) {
    player.velocity = zeroVector();
    advance(state);
    return;
  }

  const tile = getTileAt(track, landing.x, landing.y);
  if (tile === null) return;

  player.position = landing;
  pushTrail(player, landing);

  if (tile === 'grass') {
    player.velocity = zeroVector();
    player.isOffTrack = true;
  } else {
    player.velocity = { ...vector };
    player.isOffTrack = false;
  }

  if (track.checkpoint && !player.passedCheckpoint) {
    player.passedCheckpoint = segmentEntersRect(from, landing, track.checkpoint);
  }

  const crossedFinish =
    player.passedCheckpoint !== false && segmentCrossesFinish(track, from, landing);
  if (crossedFinish && player.finishOrder === undefined && tile !== 'grass') {
    if (player.lap < state.totalLaps) {
      player.lap += 1;
      player.passedCheckpoint = false;
      player.trail = [{ ...landing }];
      console.log(`[MOCK] lap ${player.lap}`);
    } else {
      player.finishOrder = state.podium.length + 1;
      player.finishRound = state.round;
      state.podium.push({
        connectionId: player.connectionId,
        nickname: player.nickname,
        position: player.finishOrder,
      });
      console.log(`[MOCK] ${player.nickname} finished in round ${state.round}`);
    }
  }

  advance(state);
}

function advance(state: GameState): void {
  // Solo race: the turn always comes back to the same player; bump the round.
  state.round += 1;
}
