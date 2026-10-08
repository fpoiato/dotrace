/**
 * Run: npx tsx frontend/dotrace-app/src/app/features/game/relay-board.test.ts
 */
import { GameState, MoveRecord } from '../../core/models/ws-types';
import { REPLAY_CHUNK, RELAY_TRAIL_POINTS, replayChunks, slimBoard } from './relay-board';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const trail = Array.from({ length: 80 }, (_, i) => ({ x: i, y: 1 }));
const state = {
  phase: 'GAME_ROUND',
  players: [{ connectionId: 'h', nickname: 'F', trail }],
  replayLog: Array.from({ length: 200 }, (_, i) => ({ seq: i, round: 58, connectionId: 'h', position: { x: 1, y: 1 }, velocity: { x: 0, y: 0 }, isOffTrack: false, lap: 1 })),
} as GameState;

const slim = slimBoard(state);
assert(slim.replayLog === undefined, 'relay board drops the replay');
assert(slim.players[0]!.trail.length === RELAY_TRAIL_POINTS, 'trail is capped');
assert(state.replayLog?.length === 200, 'host log is not mutated');
assert(state.players[0]!.trail.length === 80, 'host trail is not mutated');
const chunks = replayChunks(state.replayLog as MoveRecord[]);
assert(chunks.length === Math.ceil(200 / REPLAY_CHUNK), 'replay is split under the frame limit');
assert(chunks.every((chunk) => chunk.length <= REPLAY_CHUNK), 'no chunk is oversized');
console.log('relay-board.test.ts ok');
