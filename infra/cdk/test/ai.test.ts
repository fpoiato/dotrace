/**
 * Tests for the shared bot brain (shared/ai.ts).
 *
 * The brain only ever picks velocities offered by getValidMoves(), and the
 * race simulations below drive bots through full laps on every circuit
 * using the same rules as the host's GameEngineService.applyMove().
 */
import {
  BotDifficulty,
  GameState,
  Player,
  TrackDefinition,
  Vector2D,
  applyGrassPenalty,
  createInitialState,
  createLobbyPlayer,
  getTileAt,
  getValidMoves,
  isGameOver,
  isGrassShortcut,
  landingPosition,
  nextActiveTurnIndex,
  segmentCrossesFinish,
  segmentEntersRect,
  zeroVector,
} from '../../../shared/ws-types';
import { TRACKS } from '../../../shared/tracks';
import { computeBotMove } from '../../../shared/ai';

/** Deterministic PRNG (mulberry32) so races are reproducible. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeBot(id: string, difficulty: BotDifficulty, joinOrder: number): Player {
  return {
    ...createLobbyPlayer(id, `Bot ${joinOrder + 1}`, false, joinOrder, '#ffffff'),
    isBot: true,
    botDifficulty: difficulty,
  };
}

function startRaceOn(track: TrackDefinition, bots: Player[], totalLaps = 1): GameState {
  const state = createInitialState(bots, bots[0].connectionId);
  state.trackId = track.id;
  state.totalLaps = totalLaps;
  state.gameMode = 'TURNS';
  // createInitialState shallow-copies players: place the copies on the grid.
  state.players.forEach((p, idx) => {
    const start = track.startLine[idx % track.startLine.length];
    p.position = { ...start };
    p.velocity = zeroVector();
    p.passedCheckpoint = false;
    p.trail = [{ ...start }];
    p.lap = 1;
  });
  state.turnOrder = state.players.map((p) => p.connectionId);
  state.currentTurnIndex = 0;
  state.round = 1;
  state.phase = 'GAME_ROUND';
  state.raceStartedAt = Date.now();
  return state;
}

/** Headless mirror of the host's applyMove() rules (game-engine.service.ts). */
function applyMove(
  state: GameState,
  track: TrackDefinition,
  player: Player,
  vector: Vector2D
): void {
  const from = { ...player.position };
  const landing = landingPosition(player.position, vector);
  const tile = getTileAt(track, landing.x, landing.y);
  if (tile === null) throw new Error(`Bot landed outside the grid at ${landing.x},${landing.y}`);

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
  if (
    crossedFinish &&
    player.finishOrder === undefined &&
    tile !== 'grass' &&
    tile !== 'rumble'
  ) {
    if (player.lap < state.totalLaps) {
      player.lap += 1;
      player.passedCheckpoint = false;
    } else {
      player.finishOrder = state.podium.length + 1;
      player.finishRound = state.round;
      state.podium.push({
        connectionId: player.connectionId,
        nickname: player.nickname,
        position: player.finishOrder,
      });
    }
  }

  const prevIndex = state.currentTurnIndex;
  state.currentTurnIndex = nextActiveTurnIndex(state);
  if (state.currentTurnIndex <= prevIndex) state.round += 1;
}

function simulateRace(
  track: TrackDefinition,
  difficulty: BotDifficulty,
  botCount: number,
  maxTurns: number,
  seed = 42,
  totalLaps = 1
): GameState {
  const rng = makeRng(seed);
  const bots = Array.from({ length: botCount }, (_, i) => makeBot(`bot-${i}`, difficulty, i));
  const state = startRaceOn(track, bots, totalLaps);

  let turns = 0;
  while (!isGameOver(state) && turns < maxTurns) {
    const id = state.turnOrder[state.currentTurnIndex];
    const player = state.players.find((p) => p.connectionId === id)!;
    const vector = computeBotMove(player, state, track, difficulty, rng);

    // The brain must always stay inside the host's legal move set.
    const legal = getValidMoves(player, track, state.players, state.round).some(
      (m) => m.velocity.x === vector.x && m.velocity.y === vector.y
    );
    if (!legal) {
      throw new Error(
        `Illegal bot move on ${track.id}: v=(${vector.x},${vector.y}) from ` +
          `pos=(${player.position.x},${player.position.y}) vel=(${player.velocity.x},${player.velocity.y})`
      );
    }

    applyMove(state, track, player, vector);
    turns++;
  }
  return state;
}

describe('computeBotMove legality', () => {
  const rng = makeRng(7);

  it('always returns a host-legal velocity from random track positions', () => {
    for (const track of TRACKS) {
      for (const difficulty of ['EASY', 'MEDIUM', 'HARD'] as const) {
        for (let sample = 0; sample < 25; sample++) {
          // Drop the bot on a random drivable tile with a random low gear.
          const drivable: Vector2D[] = [];
          for (let y = 0; y < track.height; y++) {
            for (let x = 0; x < track.width; x++) {
              const t = getTileAt(track, x, y);
              if (t === 'track' || t === 'finish') drivable.push({ x, y });
            }
          }
          const pos = drivable[Math.floor(rng() * drivable.length)];
          const state = startRaceOn(track, [makeBot('bot-0', difficulty, 0)]);
          const bot = state.players[0];
          bot.position = { ...pos };
          bot.velocity = {
            x: Math.floor(rng() * 5) - 2,
            y: Math.floor(rng() * 5) - 2,
          };
          bot.passedCheckpoint = rng() < 0.5;
          state.round = 1 + Math.floor(rng() * 5);

          const vector = computeBotMove(bot, state, track, difficulty, rng);
          const legal = getValidMoves(bot, track, state.players, state.round).some(
            (m) => m.velocity.x === vector.x && m.velocity.y === vector.y
          );
          expect(legal).toBe(true);
        }
      }
    }
  });
});

describe('racing direction', () => {
  it('bots leave the start line following the track arrows, not against them', () => {
    // Regression: an undirected distance field lets bots drive the short way
    // to the checkpoint — backwards over the finish stripe (monza did).
    for (const track of TRACKS) {
      const rng = makeRng(11);
      const bot = makeBot('bot-0', 'HARD', 0);
      const state = startRaceOn(track, [bot]);
      const car = state.players[0];
      const start = { ...car.position };
      for (let turn = 0; turn < 4; turn++) {
        applyMove(state, track, car, computeBotMove(car, state, track, 'HARD', rng));
      }
      // The arrow at the start points along the race direction; after a few
      // moves the car must have moved along it (dot product > 0).
      const arrow = track.arrows[0];
      const dx = car.position.x - start.x;
      const dy = car.position.y - start.y;
      expect(dx * arrow.dir.x + dy * arrow.dir.y).toBeGreaterThan(0);
    }
  });
});

describe('race simulation — bots finish every circuit', () => {
  for (const track of TRACKS) {
    it(`HARD bots complete a 3-car race on ${track.id}`, () => {
      const state = simulateRace(track, 'HARD', 3, 600);
      expect(isGameOver(state)).toBe(true);
      expect(state.podium.length).toBe(3);
      expect(state.round).toBeLessThanOrEqual(200);
    });

    it(`MEDIUM bot completes a solo lap on ${track.id}`, () => {
      const state = simulateRace(track, 'MEDIUM', 1, 500);
      expect(isGameOver(state)).toBe(true);
      expect(state.players[0].finishOrder).toBe(1);
    });

    it(`EASY bot completes a solo lap on ${track.id}`, () => {
      const state = simulateRace(track, 'EASY', 1, 1500);
      expect(isGameOver(state)).toBe(true);
      expect(state.players[0].finishOrder).toBe(1);
    });
  }

  it('HARD bot completes a 2-lap race (checkpoint rearms between laps)', () => {
    const state = simulateRace(TRACKS[0], 'HARD', 1, 600, 42, 2);
    expect(isGameOver(state)).toBe(true);
    expect(state.players[0].lap).toBe(2);
    expect(state.players[0].finishOrder).toBe(1);
  });

  it('HARD bots race faster than EASY bots', () => {
    const track = TRACKS[0];
    const hard = simulateRace(track, 'HARD', 1, 600, 99);
    const easy = simulateRace(track, 'EASY', 1, 1500, 99);
    expect(hard.round).toBeLessThan(easy.round);
  });
});
