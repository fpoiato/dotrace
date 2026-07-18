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
  gearOf,
  getValidMoves,
  canPlayerMove,
  isGameOver,
  isValidGearChange,
  nextActiveTurnIndex,
  rollDice,
  generateRoomCode,
  segmentCrossesFinish,
  segmentEntersRect,
  buildRaceTelemetry,
  formatRaceTime,
  applyGrassPenalty,
  GRASS_PENALTY_TURNS_FIRST,
  GRASS_PENALTY_TURNS_REPEAT,
  GRASS_PENALTY_TIMED_FIRST_MS,
  GRASS_PENALTY_TIMED_REPEAT_MS,
  isGearLimited,
  isGrassShortcut,
  isPlayerStopped,
  segmentCrossesGrass,
  segmentCrossesRumble,
} from '../../../shared/ws-types';
import { TRACKS } from '../../../shared/tracks';

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

  it('blocks timed racers during a grass stop penalty', () => {
    const now = 1_000_000;
    const timed: GameState = {
      ...base,
      gameMode: 'TIMED',
      players: [
        makePlayer({ stopUntil: now + 5000 }),
        makePlayer({ connectionId: 'c2', nickname: 'Bia', joinOrder: 1, color: '#000' }),
      ],
    };
    expect(canPlayerMove(timed, 'c1', now)).toBe(false);
    expect(canPlayerMove(timed, 'c1', now + 5000)).toBe(true);
    expect(canPlayerMove(timed, 'c2', now)).toBe(true);
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

describe('grass shortcut penalties', () => {
  it('detects cutting through grass without landing on it', () => {
    const track = makeTrack();
    // grass column at x=5; fly from x=3 to x=4 at y=1 — path crosses x=5? No.
    // Move from (4,1) to (4,1) with step through grass at (5,1): from (3,1) to (4,1) doesn't cross.
    // Jump from (4,1) to (4,1)... need a move that crosses grass.
    expect(segmentCrossesGrass(track, { x: 4, y: 1 }, { x: 4, y: 1 })).toBe(false);
    expect(segmentCrossesGrass(track, { x: 4, y: 1 }, { x: 5, y: 1 })).toBe(true);
    expect(isGrassShortcut(track, { x: 4, y: 1 }, { x: 5, y: 1 })).toBe(true);
    expect(isGrassShortcut(track, { x: 2, y: 1 }, { x: 3, y: 1 })).toBe(false);
  });

  it('does not count leaving grass as a shortcut', () => {
    const track = makeTrack();
    expect(segmentCrossesGrass(track, { x: 5, y: 1 }, { x: 4, y: 1 })).toBe(false);
  });

  it('applies 3-round gear cap on first turns-mode cut, 5 on repeat', () => {
    const player = makePlayer();
    const state: GameState = {
      phase: 'GAME_ROUND',
      players: [player],
      hostId: 'c1',
      trackId: 'test',
      turnOrder: ['c1'],
      currentTurnIndex: 0,
      round: 10,
      totalLaps: 1,
      gameMode: 'TURNS',
      diceRolls: {},
      podium: [],
    };

    applyGrassPenalty(player, state, 1000);
    expect(player.grassCuts).toBe(1);
    expect(player.gearPenaltyUntilRound).toBe(13);
    expect(isGearLimited(player, 12)).toBe(true);
    expect(isGearLimited(player, 13)).toBe(true);
    expect(isGearLimited(player, 14)).toBe(false);

    applyGrassPenalty(player, state, 2000);
    expect(player.grassCuts).toBe(2);
    expect(player.gearPenaltyUntilRound).toBe(15);
  });

  it('applies timed stop penalties with repeat downgear', () => {
    const player = makePlayer({ velocity: { x: 3, y: 0 } });
    const state: GameState = {
      phase: 'GAME_ROUND',
      players: [player],
      hostId: 'c1',
      trackId: 'test',
      turnOrder: ['c1'],
      currentTurnIndex: 0,
      round: 1,
      totalLaps: 1,
      gameMode: 'TIMED',
      diceRolls: {},
      podium: [],
    };
    const now = 50_000;

    applyGrassPenalty(player, state, now);
    expect(player.stopUntil).toBe(now + GRASS_PENALTY_TIMED_FIRST_MS);
    expect(player.velocity).toEqual({ x: 3, y: 0 });
    expect(isPlayerStopped(player, now + 1000)).toBe(true);

    applyGrassPenalty(player, state, now + 10_000);
    expect(player.stopUntil).toBe(now + 10_000 + GRASS_PENALTY_TIMED_REPEAT_MS);
    expect(player.velocity).toEqual({ x: 0, y: 0 });
  });

  it('caps valid moves at gear 1 during a turns-mode grass penalty on track', () => {
    const player = makePlayer({
      position: { x: 2, y: 2 },
      velocity: { x: 3, y: 0 },
      isOffTrack: false,
      gearPenaltyUntilRound: 20,
    });
    const track = makeTrack();
    const moves = getValidMoves(player, track, undefined, 10);
    expect(moves.every((m) => Math.max(Math.abs(m.velocity.x), Math.abs(m.velocity.y)) <= 1)).toBe(
      true
    );
  });
});

describe('rumble strips', () => {
  it('detects crossing rumble tiles along a move segment', () => {
    const track = makeTrack();
    track.grid[1][4] = 'rumble';
    expect(segmentCrossesRumble(track, { x: 2, y: 1 }, { x: 4, y: 1 })).toBe(true);
    expect(segmentCrossesRumble(track, { x: 2, y: 1 }, { x: 3, y: 1 })).toBe(false);
  });

  it('stamps kerb rumble on grass beside track at sharp corners', () => {
    const monza = TRACKS.find((t) => t.id === 'monza')!;
    let rumbleCells = 0;
    let rumbleOnGrass = 0;
    for (let y = 0; y < monza.height; y++) {
      for (let x = 0; x < monza.width; x++) {
        if (monza.grid[y][x] === 'rumble') {
          rumbleCells++;
          rumbleOnGrass++;
        }
      }
    }
    expect(rumbleCells).toBeGreaterThan(10);
    expect(rumbleOnGrass).toBe(rumbleCells);
  });

  it('seals short grass gaps along the track edge inside rumble strips', () => {
    const ortho = [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ] as const;
    const maxGap = 3;

    for (const track of TRACKS) {
      for (let y = 0; y < track.height; y++) {
        for (let x = 0; x < track.width; x++) {
          if (track.grid[y][x] !== 'grass') continue;

          for (const [tdx, tdy] of ortho) {
            const toward = track.grid[y + tdy]?.[x + tdx];
            if (toward !== 'track' && toward !== 'finish') continue;

            const lx = -tdy;
            const ly = tdx;
            const hasRumble = (dir: 1 | -1): boolean => {
              for (let step = 1; step <= maxGap; step++) {
                const sx = x + lx * dir * step;
                const sy = y + ly * dir * step;
                const t = track.grid[sy]?.[sx];
                if (t === 'rumble') return true;
                if (t !== 'grass') return false;
              }
              return false;
            };

            expect(hasRumble(1) && hasRumble(-1)).toBe(false);
          }
        }
      }
    }
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
