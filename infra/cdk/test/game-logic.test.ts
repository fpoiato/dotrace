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
  MAX_REPLAY_MOVES,
  buildReplayState,
  createRaceReplay,
  recordReplayMove,
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

describe('race replay recording', () => {
  function makeRaceState(): GameState {
    const players = [
      makePlayer({ connectionId: 'a', position: { x: 0, y: 0 } }),
      makePlayer({ connectionId: 'b', position: { x: 0, y: 1 }, isHost: false, nickname: 'Bia' }),
    ];
    const state: GameState = {
      phase: 'GAME_ROUND',
      players,
      hostId: 'a',
      trackId: 'test',
      turnOrder: ['a', 'b'],
      currentTurnIndex: 0,
      round: 1,
      totalLaps: 2,
      gameMode: 'TURNS',
      diceRolls: {},
      podium: [],
    };
    state.replay = createRaceReplay(state, players);
    return state;
  }

  it('captures the starting grid and race settings', () => {
    const state = makeRaceState();
    expect(state.replay!.trackId).toBe('test');
    expect(state.replay!.totalLaps).toBe(2);
    expect(state.replay!.grid).toHaveLength(2);
    expect(state.replay!.grid[1]).toEqual({
      connectionId: 'b',
      nickname: 'Bia',
      color: '#fff',
      position: { x: 0, y: 1 },
    });
    expect(state.replay!.moves).toHaveLength(0);
  });

  it('records moves indexed by grid position', () => {
    const state = makeRaceState();
    const rec = recordReplayMove(state, 'b', { round: 1, to: { x: 1, y: 1 }, lap: 1 });
    expect(rec).not.toBeNull();
    expect(state.replay!.moves).toEqual([
      { player: 1, round: 1, to: { x: 1, y: 1 }, lap: 1 },
    ]);
  });

  it('ignores moves from players not on the grid', () => {
    const state = makeRaceState();
    expect(recordReplayMove(state, 'ghost', { round: 1, to: { x: 1, y: 1 }, lap: 1 })).toBeNull();
    expect(state.replay!.moves).toHaveLength(0);
  });

  it('is a no-op when no recording was started', () => {
    const state = makeRaceState();
    delete state.replay;
    expect(recordReplayMove(state, 'a', { round: 1, to: { x: 1, y: 0 }, lap: 1 })).toBeNull();
  });

  it('drops the oldest moves beyond the cap', () => {
    const state = makeRaceState();
    for (let i = 0; i < MAX_REPLAY_MOVES + 5; i++) {
      recordReplayMove(state, 'a', { round: i + 1, to: { x: i, y: 0 }, lap: 1 });
    }
    expect(state.replay!.moves).toHaveLength(MAX_REPLAY_MOVES);
    expect(state.replay!.moves[0].round).toBe(6);
  });
});

describe('race replay playback', () => {
  function makeReplay() {
    const state: GameState = {
      phase: 'GAME_ROUND',
      players: [
        makePlayer({ connectionId: 'a', position: { x: 0, y: 0 } }),
        makePlayer({ connectionId: 'b', position: { x: 0, y: 1 }, isHost: false, nickname: 'Bia' }),
      ],
      hostId: 'a',
      trackId: 'test',
      turnOrder: ['a', 'b'],
      currentTurnIndex: 0,
      round: 1,
      totalLaps: 2,
      gameMode: 'TURNS',
      diceRolls: {},
      podium: [],
    };
    state.replay = createRaceReplay(state, state.players);
    recordReplayMove(state, 'a', { round: 1, to: { x: 1, y: 0 }, lap: 1 });
    recordReplayMove(state, 'b', { round: 1, to: { x: 1, y: 1 }, lap: 1, offTrack: true });
    recordReplayMove(state, 'a', { round: 2, to: { x: 1, y: 0 }, lap: 1, crashed: true });
    recordReplayMove(state, 'b', { round: 2, to: { x: 2, y: 1 }, lap: 2 });
    return state.replay!;
  }

  it('step 0 is the starting grid', () => {
    const frame = buildReplayState(makeReplay(), 0);
    expect(frame.players[0].position).toEqual({ x: 0, y: 0 });
    expect(frame.players[1].position).toEqual({ x: 0, y: 1 });
    expect(frame.players[0].trail).toEqual([{ x: 0, y: 0 }]);
    expect(frame.turnOrder).toEqual([]);
    expect(frame.round).toBe(1);
  });

  it('applies moves cumulatively and grows trails', () => {
    const frame = buildReplayState(makeReplay(), 2);
    expect(frame.players[0].position).toEqual({ x: 1, y: 0 });
    expect(frame.players[1].position).toEqual({ x: 1, y: 1 });
    expect(frame.players[0].trail).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
    expect(frame.players[1].isOffTrack).toBe(true);
    expect(frame.turnOrder).toEqual(['replay:1']);
  });

  it('keeps a crashed car in place without extending its trail', () => {
    const frame = buildReplayState(makeReplay(), 3);
    expect(frame.players[0].position).toEqual({ x: 1, y: 0 });
    expect(frame.players[0].trail).toHaveLength(2);
    expect(frame.round).toBe(2);
    expect(frame.turnOrder).toEqual(['replay:0']);
  });

  it('resets the trail when a new lap starts', () => {
    const frame = buildReplayState(makeReplay(), 4);
    expect(frame.players[1].lap).toBe(2);
    expect(frame.players[1].trail).toEqual([{ x: 2, y: 1 }]);
    expect(frame.players[1].isOffTrack).toBe(false);
  });

  it('clamps the step to the recording length', () => {
    const replay = makeReplay();
    expect(buildReplayState(replay, 99).players[1].position).toEqual({ x: 2, y: 1 });
    expect(buildReplayState(replay, -5).players[0].position).toEqual({ x: 0, y: 0 });
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
