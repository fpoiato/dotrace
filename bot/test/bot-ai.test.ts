/**
 * Full-race simulation of the shared bot AI on every circuit.
 * Mirrors the host's applyMove logic from game-engine.service.ts so the AI
 * races under the real rules (grass traps, checkpoint gate, lap counting).
 */
import { chooseBotMove, createBotMemory } from '../../shared/bot-ai';
import { TRACKS } from '../../shared/tracks';
import {
  GameState,
  Player,
  TrackDefinition,
  applyGrassPenalty,
  createBotPlayer,
  createInitialState,
  getTileAt,
  getValidMoves,
  isGrassShortcut,
  landingPosition,
  segmentCrossesFinish,
  segmentEntersRect,
  zeroVector,
} from '../../shared/ws-types';

const MAX_ROUNDS = 400;
const BOT_COUNT = 3;

/** Faithful copy of the host's move application (game-engine.applyMove). */
function applyHostMove(state: GameState, player: Player, vector: { x: number; y: number }, track: TrackDefinition): void {
  const from = { ...player.position };
  const landing = landingPosition(player.position, vector);
  const tile = getTileAt(track, landing.x, landing.y);
  if (tile === null) throw new Error(`AI move landed off-grid at ${landing.x},${landing.y}`);

  const grassShortcut = isGrassShortcut(track, from, landing);
  player.position = landing;

  if (tile === 'grass' || tile === 'rumble') {
    player.velocity = zeroVector();
    player.isOffTrack = true;
  } else {
    player.velocity = { ...vector };
    player.isOffTrack = false;
  }

  if (grassShortcut) applyGrassPenalty(player, state);

  if (track.checkpoint && !player.passedCheckpoint) {
    player.passedCheckpoint = segmentEntersRect(from, landing, track.checkpoint);
  }

  const crossedFinish =
    player.passedCheckpoint !== false && segmentCrossesFinish(track, from, landing);
  if (crossedFinish && player.finishOrder === undefined && tile !== 'grass' && tile !== 'rumble') {
    if (player.lap < state.totalLaps) {
      player.lap += 1;
      player.passedCheckpoint = false;
    } else {
      player.finishOrder = state.podium.length + 1;
      state.podium.push({
        connectionId: player.connectionId,
        nickname: player.nickname,
        position: player.finishOrder,
      });
    }
  }
}

function simulateRace(track: TrackDefinition): { state: GameState; rounds: number } {
  const players = Array.from({ length: BOT_COUNT }, (_, i) =>
    createBotPlayer(i + 1, i + 1, '#3B82F6')
  );
  const state = createInitialState(players, players[0].connectionId);
  state.trackId = track.id;
  state.totalLaps = 1;
  state.gameMode = 'TURNS';
  state.phase = 'GAME_ROUND';
  state.raceStartedAt = Date.now();
  players.forEach((p, idx) => {
    const start = track.startLine[idx % track.startLine.length];
    p.position = { ...start };
    p.velocity = zeroVector();
    p.trail = [{ ...start }];
    p.passedCheckpoint = false;
  });
  state.turnOrder = players.map((p) => p.connectionId);

  const memories = new Map(players.map((p) => [p.connectionId, createBotMemory()]));

  let rounds = 0;
  while (rounds < MAX_ROUNDS && state.podium.length < BOT_COUNT) {
    rounds += 1;
    state.round = rounds;
    for (const p of players) {
      if (p.finishOrder !== undefined) continue;
      const velocity = chooseBotMove(p, track, players, rounds, memories.get(p.connectionId)!);
      // The AI must always answer with a host-legal move.
      const legal = getValidMoves(p, track, players, rounds).some(
        (m) => m.velocity.x === velocity.x && m.velocity.y === velocity.y
      );
      if (!legal) {
        throw new Error(
          `AI picked illegal velocity (${velocity.x},${velocity.y}) on ${track.id} round ${rounds}`
        );
      }
      applyHostMove(state, p, velocity, track);
    }
  }

  return { state, rounds };
}

describe('bot AI race simulation', () => {
  for (const track of TRACKS) {
    it(`finishes a 1-lap race on ${track.id} without soft-locking`, () => {
      const { state, rounds } = simulateRace(track);
      // eslint-disable-next-line no-console
      console.log(
        `[sim] ${track.id}: ${rounds} rounds, grassCuts=${state.players
          .map((p) => p.grassCuts ?? 0)
          .join('/')}`
      );
      expect(state.podium.length).toBe(BOT_COUNT);
      expect(rounds).toBeLessThan(MAX_ROUNDS);
    });
  }
});
