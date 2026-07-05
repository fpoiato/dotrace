/**
 * Tests for the shared host-authoritative game rules (shared/ws-types.ts).
 * These rules run in the host's browser but are the core of move validation,
 * so they are covered here in CI alongside the backend.
 */
import {
  GameState,
  Player,
  TrackDefinition,
  createLobbyPlayer,
  findCollisionOpponent,
  gearOf,
  getValidMoves,
  canPlayerMove,
  isGameOver,
  isValidGearChange,
  nextActiveTurnIndex,
  rollDice,
  generateRoomCode,
  segmentCrossesCell,
  segmentCrossesFinish,
  segmentEntersRect,
  buildRaceTelemetry,
  formatRaceTime,
  formatLapTime,
  closeLap,
  bestLapMs,
  buildLeaderboard,
} from '../../../shared/ws-types';

function makeTrack(): TrackDefinition {
  // 6x4: all track except a grass border on the right column.
  const grid = Array.from({ length: 4 }, () =>
    Array.from({ length: 6 }, () => 'track' as const)
  ) as TrackDefinition['grid'];
  for (let y = 0; y < 4; y++) grid[y][5] = 'grass';
  return {
    id: 'test',
    nameKey: 'tracks.test',
    width: 6,
    height: 4,
    grid,
    startLine: [{ x: 0, y: 0 }],
    arrows: [],
  };
}

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    ...createLobbyPlayer('c1', 'Ana', true, 0, '#fff'),
    ...overrides,
  };
}

describe('gear change validation (±1 rule)', () => {
  it('accepts adjustments of at most ±1 per axis', () => {
    expect(isValidGearChange({ x: 2, y: 0 }, { x: 3, y: 1 }, false)).toBe(true);
    expect(isValidGearChange({ x: 2, y: 0 }, { x: 2, y: 0 }, false)).toBe(true);
    expect(isValidGearChange({ x: 2, y: 0 }, { x: 1, y: -1 }, false)).toBe(true);
  });

  it('rejects adjustments greater than ±1 on any axis', () => {
    expect(isValidGearChange({ x: 2, y: 0 }, { x: 4, y: 0 }, false)).toBe(false);
    expect(isValidGearChange({ x: 2, y: 0 }, { x: 2, y: 2 }, false)).toBe(false);
    expect(isValidGearChange({ x: 0, y: 0 }, { x: -2, y: 0 }, false)).toBe(false);
  });

  it('caps off-track players to gear 1 (components in {-1,0,1})', () => {
    expect(isValidGearChange({ x: 0, y: 0 }, { x: 1, y: 1 }, true)).toBe(true);
    expect(isValidGearChange({ x: 1, y: 0 }, { x: 2, y: 0 }, true)).toBe(false);
  });

  it('caps top speed at gear 6', () => {
    expect(isValidGearChange({ x: 5, y: 0 }, { x: 6, y: 0 }, false)).toBe(true);
    expect(isValidGearChange({ x: 6, y: 0 }, { x: 7, y: 0 }, false)).toBe(false);
    expect(isValidGearChange({ x: 6, y: 5 }, { x: 6, y: 6 }, false)).toBe(true);
    expect(isValidGearChange({ x: -6, y: 0 }, { x: -7, y: 1 }, false)).toBe(false);
  });
});

describe('valid move enumeration', () => {
  it('returns the 9 gear options for a stationary on-track player mid-grid', () => {
    const player = makePlayer({ position: { x: 2, y: 2 } });
    const track = makeTrack();
    expect(getValidMoves(player, track)).toHaveLength(9);
  });

  it('excludes landings outside the grid', () => {
    const player = makePlayer({ position: { x: 0, y: 0 } });
    const track = makeTrack();
    const moves = getValidMoves(player, track);
    expect(moves.every((m) => m.landing.x >= 0 && m.landing.y >= 0)).toBe(true);
    expect(moves).toHaveLength(4);
  });

  it('offers an emergency stop when every landing would leave the grid', () => {
    // Speeding right at the edge: all ±1 adjustments still land out of bounds.
    const player = makePlayer({ position: { x: 5, y: 1 }, velocity: { x: 4, y: 0 } });
    const track = makeTrack();
    const moves = getValidMoves(player, track);
    expect(moves).toHaveLength(1);
    expect(moves[0].velocity).toEqual({ x: 0, y: 0 });
    expect(moves[0].landing).toEqual({ x: 5, y: 1 });
  });

  it('excludes landings occupied by another active racer', () => {
    const player = makePlayer({ connectionId: 'a', position: { x: 2, y: 2 } });
    const blocker = makePlayer({ connectionId: 'b', position: { x: 3, y: 2 }, isHost: false });
    const track = makeTrack();
    const moves = getValidMoves(player, track, [player, blocker]);
    expect(moves.some((m) => m.landing.x === 3 && m.landing.y === 2)).toBe(false);
  });

  it('ignores finished players when checking occupancy', () => {
    const player = makePlayer({ connectionId: 'a', position: { x: 2, y: 2 } });
    const parked = makePlayer({
      connectionId: 'b',
      position: { x: 3, y: 2 },
      isHost: false,
      finishOrder: 1,
    });
    const track = makeTrack();
    const moves = getValidMoves(player, track, [player, parked]);
    expect(moves.some((m) => m.landing.x === 3 && m.landing.y === 2)).toBe(true);
  });
});

describe('car collisions', () => {
  it('detects flying through another car along the segment', () => {
    expect(segmentCrossesCell({ x: 0, y: 1 }, { x: 4, y: 1 }, { x: 2, y: 1 })).toBe(true);
    expect(segmentCrossesCell({ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 3, y: 3 })).toBe(false);
  });

  it('finds an opponent when landing on their cell', () => {
    const mover = makePlayer({ connectionId: 'a', position: { x: 1, y: 1 } });
    const other = makePlayer({ connectionId: 'b', position: { x: 3, y: 1 }, isHost: false });
    expect(
      findCollisionOpponent('a', mover.position, { x: 3, y: 1 }, [mover, other])
    ).toBe(other);
  });

  it('finds an opponent when the path crosses their cell without landing on it', () => {
    const mover = makePlayer({ connectionId: 'a', position: { x: 0, y: 1 }, velocity: { x: 4, y: 0 } });
    const other = makePlayer({ connectionId: 'b', position: { x: 2, y: 1 }, isHost: false });
    expect(
      findCollisionOpponent('a', mover.position, { x: 4, y: 1 }, [mover, other])
    ).toBe(other);
  });

  it('ignores finished racers for collisions', () => {
    const mover = makePlayer({ connectionId: 'a', position: { x: 1, y: 1 } });
    const other = makePlayer({
      connectionId: 'b',
      position: { x: 3, y: 1 },
      isHost: false,
      finishOrder: 1,
    });
    expect(
      findCollisionOpponent('a', mover.position, { x: 3, y: 1 }, [mover, other])
    ).toBeNull();
  });
});

describe('turn order', () => {
  function makeState(): GameState {
    const players = [
      makePlayer({ connectionId: 'a', joinOrder: 0 }),
      makePlayer({ connectionId: 'b', joinOrder: 1, isHost: false }),
      makePlayer({ connectionId: 'c', joinOrder: 2, isHost: false }),
    ];
    return {
      phase: 'GAME_ROUND',
      players,
      hostId: 'a',
      trackId: 'test',
      turnOrder: ['a', 'b', 'c'],
      currentTurnIndex: 0,
      round: 1,
      totalLaps: 1,
      gameMode: 'TURNS',
      diceRolls: {},
      podium: [],
    };
  }

  it('advances to the next player', () => {
    const state = makeState();
    expect(nextActiveTurnIndex(state)).toBe(1);
  });

  it('skips players who already finished', () => {
    const state = makeState();
    state.players[1].finishOrder = 1;
    expect(nextActiveTurnIndex(state)).toBe(2);
  });

  it('wraps around the order', () => {
    const state = makeState();
    state.currentTurnIndex = 2;
    expect(nextActiveTurnIndex(state)).toBe(0);
  });
});

describe('game over conditions', () => {
  it('ends when the podium is full', () => {
    const state: GameState = {
      phase: 'GAME_ROUND',
      players: [makePlayer()],
      hostId: 'c1',
      trackId: 'test',
      turnOrder: ['c1'],
      currentTurnIndex: 0,
      round: 1,
      totalLaps: 1,
      gameMode: 'TURNS',
      diceRolls: {},
      podium: [
        { connectionId: 'x', nickname: 'X', position: 1 },
        { connectionId: 'y', nickname: 'Y', position: 2 },
        { connectionId: 'z', nickname: 'Z', position: 3 },
      ],
    };
    expect(isGameOver(state)).toBe(true);
  });

  it('ends when every player finished', () => {
    const state: GameState = {
      phase: 'GAME_ROUND',
      players: [makePlayer({ finishOrder: 1 })],
      hostId: 'c1',
      trackId: 'test',
      turnOrder: ['c1'],
      currentTurnIndex: 0,
      round: 1,
      totalLaps: 1,
      gameMode: 'TURNS',
      diceRolls: {},
      podium: [{ connectionId: 'c1', nickname: 'Ana', position: 1 }],
    };
    expect(isGameOver(state)).toBe(true);
  });

  it('continues while racers remain and podium is open', () => {
    const state: GameState = {
      phase: 'GAME_ROUND',
      players: [makePlayer(), makePlayer({ connectionId: 'c2', finishOrder: 1 })],
      hostId: 'c1',
      trackId: 'test',
      turnOrder: ['c1', 'c2'],
      currentTurnIndex: 0,
      round: 1,
      totalLaps: 1,
      gameMode: 'TURNS',
      diceRolls: {},
      podium: [{ connectionId: 'c2', nickname: 'Bia', position: 1 }],
    };
    expect(isGameOver(state)).toBe(false);
  });

  it('ends timed mode as soon as the first player finishes', () => {
    const state: GameState = {
      phase: 'GAME_ROUND',
      players: [makePlayer({ finishOrder: 1 }), makePlayer({ connectionId: 'c2' })],
      hostId: 'c1',
      trackId: 'test',
      turnOrder: ['c1', 'c2'],
      currentTurnIndex: 0,
      round: 1,
      totalLaps: 1,
      gameMode: 'TIMED',
      diceRolls: {},
      podium: [{ connectionId: 'c1', nickname: 'Ana', position: 1 }],
    };
    expect(isGameOver(state)).toBe(true);
  });
});

describe('canPlayerMove', () => {
  const base: GameState = {
    phase: 'GAME_ROUND',
    players: [makePlayer(), makePlayer({ connectionId: 'c2', nickname: 'Bia', joinOrder: 1, color: '#000' })],
    hostId: 'c1',
    trackId: 'test',
    turnOrder: ['c1', 'c2'],
    currentTurnIndex: 0,
    round: 1,
    totalLaps: 1,
    gameMode: 'TURNS',
    diceRolls: {},
    podium: [],
  };

  it('allows only the active player in turns mode', () => {
    expect(canPlayerMove(base, 'c1')).toBe(true);
    expect(canPlayerMove(base, 'c2')).toBe(false);
  });

  it('allows any active racer in timed mode', () => {
    const timed = { ...base, gameMode: 'TIMED' as const };
    expect(canPlayerMove(timed, 'c1')).toBe(true);
    expect(canPlayerMove(timed, 'c2')).toBe(true);
  });

  it('blocks finished players in timed mode', () => {
    const timed: GameState = {
      ...base,
      gameMode: 'TIMED',
      players: [makePlayer({ finishOrder: 1 }), makePlayer({ connectionId: 'c2', nickname: 'Bia', joinOrder: 1, color: '#000' })],
    };
    expect(canPlayerMove(timed, 'c1')).toBe(false);
    expect(canPlayerMove(timed, 'c2')).toBe(true);
  });
});

describe('finish line crossing', () => {
  function trackWithStripe(): TrackDefinition {
    const t = makeTrack();
    // vertical stripe at x=3
    for (let y = 0; y < 4; y++) t.grid[y][3] = 'finish';
    return t;
  }

  it('detects landing on the stripe', () => {
    expect(segmentCrossesFinish(trackWithStripe(), { x: 2, y: 1 }, { x: 3, y: 1 })).toBe(true);
  });

  it('detects flying over the stripe without landing on it', () => {
    expect(segmentCrossesFinish(trackWithStripe(), { x: 1, y: 1 }, { x: 4, y: 1 })).toBe(true);
  });

  it('does not trigger when the move stays clear of the stripe', () => {
    expect(segmentCrossesFinish(trackWithStripe(), { x: 0, y: 0 }, { x: 1, y: 2 })).toBe(false);
  });

  it('checkpoint detection samples the whole segment', () => {
    const rect = { x0: 2, y0: 0, x1: 2, y1: 3 };
    expect(segmentEntersRect({ x: 0, y: 1 }, { x: 4, y: 1 }, rect)).toBe(true);
    expect(segmentEntersRect({ x: 0, y: 0 }, { x: 1, y: 3 }, rect)).toBe(false);
  });
});

describe('gear', () => {
  it('is the Chebyshev magnitude of velocity', () => {
    expect(gearOf({ x: 0, y: 0 })).toBe(0);
    expect(gearOf({ x: 2, y: 0 })).toBe(2);
    expect(gearOf({ x: -3, y: 2 })).toBe(3);
    expect(gearOf({ x: 1, y: -4 })).toBe(4);
  });
});

describe('race telemetry', () => {
  it('builds a snapshot with player positions and elapsed time', () => {
    const state: GameState = {
      phase: 'GAME_ROUND',
      players: [
        makePlayer({ connectionId: 'a', position: { x: 3, y: 5 }, lap: 2 }),
        makePlayer({ connectionId: 'b', position: { x: 10, y: 2 }, lap: 1, isHost: false }),
      ],
      hostId: 'a',
      trackId: 'test',
      turnOrder: ['a', 'b'],
      currentTurnIndex: 0,
      round: 4,
      totalLaps: 2,
      gameMode: 'TURNS',
      diceRolls: {},
      podium: [],
      raceStartedAt: 1_000,
    };

    const snap = buildRaceTelemetry(state, 61_000);
    expect(snap).not.toBeNull();
    expect(snap!.elapsedMs).toBe(60_000);
    expect(snap!.round).toBe(4);
    expect(snap!.players).toHaveLength(2);
    expect(snap!.players[0].position).toEqual({ x: 3, y: 5 });
    expect(snap!.players[1].position).toEqual({ x: 10, y: 2 });
  });

  it('returns null before the race starts', () => {
    const state: GameState = {
      phase: 'GRID_ORDER',
      players: [makePlayer()],
      hostId: 'c1',
      trackId: 'test',
      turnOrder: [],
      currentTurnIndex: 0,
      round: 1,
      totalLaps: 1,
      gameMode: 'TURNS',
      diceRolls: {},
      podium: [],
    };
    expect(buildRaceTelemetry(state)).toBeNull();
  });

  it('formats elapsed time as m:ss', () => {
    expect(formatRaceTime(0)).toBe('0:00');
    expect(formatRaceTime(45_000)).toBe('0:45');
    expect(formatRaceTime(125_000)).toBe('2:05');
  });
});

describe('lap times', () => {
  it('closeLap records the lap duration and rearms the clock', () => {
    const player = makePlayer({ lapStartedAt: 10_000 });
    closeLap(player, 55_500);
    expect(player.lapTimes).toEqual([45_500]);
    expect(player.lapStartedAt).toBe(55_500);

    closeLap(player, 90_000);
    expect(player.lapTimes).toEqual([45_500, 34_500]);
  });

  it('closeLap is a no-op before the lap clock is armed', () => {
    const player = makePlayer();
    closeLap(player, 55_500);
    expect(player.lapTimes).toBeUndefined();
  });

  it('finds the best lap', () => {
    expect(bestLapMs([45_500, 34_500, 39_000])).toBe(34_500);
    expect(bestLapMs([])).toBeUndefined();
  });

  it('formats lap times as m:ss.t', () => {
    expect(formatLapTime(0)).toBe('0:00.0');
    expect(formatLapTime(45_567)).toBe('0:45.5');
    expect(formatLapTime(125_890)).toBe('2:05.8');
  });
});

describe('leaderboard', () => {
  function makeRaceState(): GameState {
    return {
      phase: 'GAME_ROUND',
      players: [
        makePlayer({ connectionId: 'a', nickname: 'Ana', joinOrder: 0, lap: 1, lapTimes: [] }),
        makePlayer({
          connectionId: 'b',
          nickname: 'Bia',
          joinOrder: 1,
          isHost: false,
          lap: 2,
          lapTimes: [42_000],
        }),
        makePlayer({
          connectionId: 'c',
          nickname: 'Caio',
          joinOrder: 2,
          isHost: false,
          lap: 2,
          passedCheckpoint: true,
          lapTimes: [38_000],
        }),
      ],
      hostId: 'a',
      trackId: 'test',
      turnOrder: ['a', 'b', 'c'],
      currentTurnIndex: 0,
      round: 5,
      totalLaps: 3,
      gameMode: 'TURNS',
      diceRolls: {},
      podium: [],
      raceStartedAt: 1_000,
    };
  }

  it('ranks racers by lap, then checkpoint progress, then join order', () => {
    const board = buildLeaderboard(makeRaceState());
    expect(board.map((e) => e.connectionId)).toEqual(['c', 'b', 'a']);
    expect(board.map((e) => e.rank)).toEqual([1, 2, 3]);
  });

  it('puts finishers ahead of active racers, ordered by finish position', () => {
    const state = makeRaceState();
    state.players[0].finishOrder = 1;
    state.players[0].finishedAt = 121_000;
    state.players[0].lapTimes = [40_000, 40_000, 40_000];
    const board = buildLeaderboard(state);
    expect(board[0].connectionId).toBe('a');
    expect(board[0].totalMs).toBe(120_000);
    expect(board[0].lapsCompleted).toBe(3);
  });

  it('computes best/last lap and flags the overall fastest lap', () => {
    const state = makeRaceState();
    state.players[1].lapTimes = [42_000, 36_000];
    const board = buildLeaderboard(state);
    const bia = board.find((e) => e.connectionId === 'b')!;
    const caio = board.find((e) => e.connectionId === 'c')!;
    expect(bia.bestLapMs).toBe(36_000);
    expect(bia.lastLapMs).toBe(36_000);
    expect(bia.hasFastestLap).toBe(true);
    expect(caio.hasFastestLap).toBe(false);
  });

  it('handles players with no completed laps', () => {
    const board = buildLeaderboard(makeRaceState());
    const ana = board.find((e) => e.connectionId === 'a')!;
    expect(ana.bestLapMs).toBeUndefined();
    expect(ana.lastLapMs).toBeUndefined();
    expect(ana.hasFastestLap).toBe(false);
  });
});

describe('primitives', () => {
  it('rolls 2d6 in the 2–12 range', () => {
    for (let i = 0; i < 200; i++) {
      const roll = rollDice();
      expect(roll).toBeGreaterThanOrEqual(2);
      expect(roll).toBeLessThanOrEqual(12);
    }
  });

  it('generates 5-letter room codes without ambiguous characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateRoomCode()).toMatch(/^[A-HJ-NP-Z]{5}$/);
    }
  });
});
