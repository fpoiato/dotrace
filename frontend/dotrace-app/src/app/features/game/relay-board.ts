import { GameState, MoveRecord } from '../../core/models/ws-types';

/** Pen trail kept on a live relay. The host still has the full stroke. */
export const RELAY_TRAIL_POINTS = 48;

/** Replay moves per frame. A full log blows the 128KB WebSocket limit around round 58. */
export const REPLAY_CHUNK = 80;

/**
 * Board safe to broadcast. The replay stays on the host and is sent later
 * in small chunks; a reconnect snapshot must not carry it either.
 */
export function slimBoard(state: GameState): GameState {
  const copy = structuredClone(state);
  delete copy.replayLog;
  for (const player of copy.players) {
    if (player.trail && player.trail.length > RELAY_TRAIL_POINTS) {
      player.trail = player.trail.slice(-RELAY_TRAIL_POINTS);
    }
  }
  return copy;
}

export function replayChunks(log: MoveRecord[] | undefined): MoveRecord[][] {
  const moves = log ?? [];
  const chunks: MoveRecord[][] = [];
  for (let i = 0; i < moves.length; i += REPLAY_CHUNK) {
    chunks.push(moves.slice(i, i + REPLAY_CHUNK));
  }
  return chunks;
}
