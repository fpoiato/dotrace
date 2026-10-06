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
  aiTurnToken,
  canPlayerMove,
  isGameOver,
  isValidGearChange,
  ersForwardDeltas,
  DRS_MAX_GEAR,
  ERS_MAX_DELTA,
  ERS_MAX_CHARGE,
  armDrsZones,
  beginNextLap,
  boostLimits,
  engageRequestedDrs,
  revertDrsOpen,
  settleBoostFromGears,
  spendErsIfAccepted,
  nextActiveTurnIndex,
  rollDice,
  generateRoomCode,
  segmentCrossesFinish,
  segmentEntersRect,
  buildRaceTelemetry,
  buildLiveStandings,
  formatRaceTime,
  applyGrassPenalty,
  GRASS_PENALTY_TURNS_FIRST,
  GRASS_PENALTY_TURNS_REPEAT,
  GRASS_PENALTY_TIMED_FIRST_MS,
  GRASS_PENALTY_TIMED_REPEAT_MS,
  isGearLimited,
  isGrassShortcut,
  isKerbGrass,
  isPlayerStopped,
  segmentCrossesGrass,
  segmentCrossesRumble,
  lapSplitMs,
  lapSplitRounds,
  bestLapMs,
  bestLapRounds,
  updateSessionStats,
  buildSessionRanking,
  fastestLapHolderIds,
  fewestRoundLapHolderIds,
  remapSessionStatsConnectionId,
  remapReplayLogConnectionId,
  adoptNicknameConnection,
  remapPlayerConnection,
  retargetLocalPlayer,
  createInitialState,
  buildRaceStatDeltas,
} from '../../../shared/ws-types';
import { TRACKS } from '../../../shared/tracks';
import { buildRankKey, compareLeaderboardEntries, nicknameKey } from '../lambda/src/lib/leaderboard';

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
    centerline: [
      { x: 0, y: 1 },
      { x: 4, y: 1 },
      { x: 4, y: 2 },
      { x: 0, y: 2 },
      { x: 0, y: 1 },
    ],
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

  it('builds a stable AI turn token from the round and seat', () => {
    const state = makeState();
    state.round = 4;
    state.currentTurnIndex = 1;
    const seat = state.players[1];
    expect(aiTurnToken(state, seat)).toBe('4:1:b');
    state.gameMode = 'TIMED';
    seat.lap = 2;
    seat.position = { x: 3, y: 1 };
    seat.velocity = { x: 2, y: 0 };
    seat.stopUntil = 50;
    expect(aiTurnToken(state, seat)).toBe('b:2:3,1:2,0:50');
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

  it('ends when every human has finished and only an AI pilot is still racing', () => {
    const state: GameState = {
      phase: 'GAME_ROUND',
      players: [
        makePlayer({ finishOrder: 1 }),
        makePlayer({ connectionId: 'ai', nickname: 'IA Nova', joinOrder: 1 }),
      ],
      hostId: 'c1',
      trackId: 'test',
      turnOrder: ['c1', 'ai'],
      currentTurnIndex: 1,
      round: 4,
      totalLaps: 1,
      gameMode: 'TURNS',
      diceRolls: {},
      podium: [{ connectionId: 'c1', nickname: 'Ana', position: 1 }],
    };
    expect(isGameOver(state)).toBe(true);
  });

  it('keeps going while a human is still racing beside the AI', () => {
    const state: GameState = {
      phase: 'GAME_ROUND',
      players: [
        makePlayer(),
        makePlayer({ connectionId: 'ai', nickname: 'Bot Laya', joinOrder: 1, finishOrder: 1 }),
      ],
      hostId: 'c1',
      trackId: 'test',
      turnOrder: ['c1', 'ai'],
      currentTurnIndex: 0,
      round: 2,
      totalLaps: 1,
      gameMode: 'TURNS',
      diceRolls: {},
      podium: [{ connectionId: 'ai', nickname: 'Bot Laya', position: 1 }],
    };
    expect(isGameOver(state)).toBe(false);
  });

  it('does not end a bots-only race when the first bot finishes', () => {
    const state: GameState = {
      phase: 'GAME_ROUND',
      players: [
        makePlayer({ nickname: 'IA Alfa', finishOrder: 1 }),
        makePlayer({ connectionId: 'ai2', nickname: 'Bot Beta', joinOrder: 1 }),
      ],
      hostId: 'ai2',
      trackId: 'test',
      turnOrder: ['c1', 'ai2'],
      currentTurnIndex: 1,
      round: 3,
      totalLaps: 1,
      gameMode: 'TURNS',
      diceRolls: {},
      podium: [{ connectionId: 'c1', nickname: 'IA Alfa', position: 1 }],
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
    // x=5 is the zebra square beside the asphalt. Push a second grass cell
    // past it so the infield is real grass, not the border.
    track.grid[1][4] = 'grass';
    expect(isKerbGrass(track, 4, 1)).toBe(true);
    expect(isKerbGrass(track, 5, 1)).toBe(false);
    expect(segmentCrossesGrass(track, { x: 3, y: 1 }, { x: 3, y: 1 })).toBe(false);
    expect(segmentCrossesGrass(track, { x: 3, y: 1 }, { x: 4, y: 1 })).toBe(false);
    expect(isGrassShortcut(track, { x: 3, y: 1 }, { x: 4, y: 1 })).toBe(false);
    expect(segmentCrossesGrass(track, { x: 3, y: 1 }, { x: 5, y: 1 })).toBe(true);
    expect(isGrassShortcut(track, { x: 3, y: 1 }, { x: 5, y: 1 })).toBe(true);
    expect(isGrassShortcut(track, { x: 2, y: 1 }, { x: 3, y: 1 })).toBe(false);
  });

  it('does not penalize clipping the zebra on Monza', () => {
    const monza = TRACKS.find((t) => t.id === 'monza')!;
    // Lesmo edge: landing on the zebra square, and a line that only nicks
    // that border while finishing on the asphalt.
    expect(isKerbGrass(monza, 36, 4)).toBe(true);
    expect(isGrassShortcut(monza, { x: 36, y: 5 }, { x: 36, y: 4 })).toBe(false);
    expect(isGrassShortcut(monza, { x: 36, y: 5 }, { x: 33, y: 6 })).toBe(false);
    expect(segmentCrossesGrass(monza, { x: 36, y: 5 }, { x: 33, y: 6 })).toBe(false);
  });

  it('still penalizes infield grass on every circuit', () => {
    for (const track of TRACKS) {
      let found = false;
      for (let y = 0; y < track.height && !found; y++) {
        for (let x = 0; x < track.width && !found; x++) {
          if (track.grid[y][x] !== 'track' && track.grid[y][x] !== 'finish') continue;
          for (let vy = -6; vy <= 6 && !found; vy++) {
            for (let vx = -6; vx <= 6 && !found; vx++) {
              if (vx === 0 && vy === 0) continue;
              const landing = { x: x + vx, y: y + vy };
              if (isGrassShortcut(track, { x, y }, landing)) found = true;
            }
          }
        }
      }
      expect(found).toBe(true);
    }
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

describe('live standings', () => {
  function standingTrack(): TrackDefinition {
    const track = makeTrack();
    // Finish stripe on the left; checkpoint on the right.
    track.grid[1][0] = 'finish';
    track.grid[2][0] = 'finish';
    track.checkpoint = { x0: 3, y0: 1, x1: 4, y1: 2 };
    return track;
  }

  it('ranks by lap, then checkpoint, then distance to goal, and keeps colors', () => {
    const track = standingTrack();
    const leader = makePlayer({
      connectionId: 'a',
      nickname: 'Leader',
      color: '#111111',
      lap: 2,
      passedCheckpoint: true,
      position: { x: 1, y: 1 },
      finishOrder: undefined,
    });
    const mid = makePlayer({
      connectionId: 'b',
      nickname: 'Mid',
      color: '#222222',
      lap: 1,
      passedCheckpoint: true,
      position: { x: 2, y: 1 },
      finishOrder: undefined,
    });
    const back = makePlayer({
      connectionId: 'c',
      nickname: 'Back',
      color: '#333333',
      lap: 1,
      passedCheckpoint: false,
      position: { x: 1, y: 1 },
      finishOrder: undefined,
    });
    const state = createInitialState([back, mid, leader], 'a');
    state.phase = 'GAME_ROUND';
    state.totalLaps = 3;
    state.players = [back, mid, leader];

    const rows = buildLiveStandings(state, track);
    expect(rows.map((r) => r.connectionId)).toEqual(['a', 'b', 'c']);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.color)).toEqual(['#111111', '#222222', '#333333']);
  });

  it('keeps finishers ahead in finishOrder and racing cars behind', () => {
    const track = standingTrack();
    const done = makePlayer({
      connectionId: 'w',
      nickname: 'Winner',
      color: '#aaa',
      lap: 3,
      finishOrder: 1,
      position: { x: 0, y: 1 },
    });
    const still = makePlayer({
      connectionId: 'r',
      nickname: 'Racing',
      color: '#bbb',
      lap: 3,
      passedCheckpoint: true,
      finishOrder: undefined,
      position: { x: 1, y: 1 },
    });
    const state = createInitialState([still, done], 'w');
    state.phase = 'GAME_ROUND';
    state.players = [still, done];

    const rows = buildLiveStandings(state, track);
    expect(rows[0].connectionId).toBe('w');
    expect(rows[0].rank).toBe(1);
    expect(rows[1].connectionId).toBe('r');
    expect(rows[1].rank).toBe(2);
  });
});

describe('lap splits and session ranking', () => {
  const startedAt = 1_000_000;

  function racePlayer(overrides: Partial<Player> = {}): Player {
    return makePlayer({
      connectionId: 'c1',
      nickname: 'Ana',
      color: '#f00',
      lapTimes: [startedAt + 30_000, startedAt + 55_000],
      lapRounds: [5, 12],
      finishOrder: 1,
      ...overrides,
    });
  }

  it('computes TIMED lap splits from raceStartedAt and prior stamps', () => {
    const p = racePlayer();
    expect(lapSplitMs(p, 1, startedAt)).toBe(30_000);
    expect(lapSplitMs(p, 2, startedAt)).toBe(25_000);
    expect(bestLapMs(p, startedAt)).toBe(25_000);
  });

  it('computes TURNS lap splits as round deltas', () => {
    const p = racePlayer();
    expect(lapSplitRounds(p, 1)).toBe(5);
    expect(lapSplitRounds(p, 2)).toBe(7);
    expect(bestLapRounds(p)).toBe(5);
  });

  it('awards fastest / fewest-round holders', () => {
    const ana = racePlayer({
      connectionId: 'a',
      nickname: 'Ana',
      lapTimes: [startedAt + 40_000],
      lapRounds: [8],
    });
    const bob = racePlayer({
      connectionId: 'b',
      nickname: 'Bob',
      color: '#0f0',
      lapTimes: [startedAt + 22_000],
      lapRounds: [6],
      finishOrder: 2,
    });
    const state = createInitialState([ana, bob], 'a');
    state.phase = 'GAME_OVER';
    state.raceStartedAt = startedAt;
    state.players = [ana, bob];
    expect(fastestLapHolderIds(state)).toEqual(['b']);
    expect(fewestRoundLapHolderIds(state)).toEqual(['b']);
  });

  it('accumulates session stats across races and sorts the ranking', () => {
    const ana = racePlayer({ connectionId: 'a', nickname: 'Ana', finishOrder: 1 });
    const bob = racePlayer({
      connectionId: 'b',
      nickname: 'Bob',
      color: '#0f0',
      finishOrder: 2,
      lapTimes: [startedAt + 20_000],
      lapRounds: [4],
    });
    const state = createInitialState([ana, bob], 'a');
    state.phase = 'GAME_OVER';
    state.gameMode = 'TIMED';
    state.raceStartedAt = startedAt;
    state.players = [ana, bob];

    updateSessionStats(state);
    expect(state.sessionStats).toHaveLength(2);
    expect(state.sessionStats!.find((s) => s.connectionId === 'a')!.wins).toBe(1);
    expect(state.sessionStats!.find((s) => s.connectionId === 'b')!.bestLapMs).toBe(20_000);

    // Second race: Bob wins, Ana DNF — wins accumulate; races increment.
    state.players = [
      { ...ana, finishOrder: undefined, lapTimes: [startedAt + 50_000], lapRounds: [9] },
      { ...bob, finishOrder: 1, lapTimes: [startedAt + 18_000], lapRounds: [3] },
    ];
    updateSessionStats(state);

    const ranking = buildSessionRanking(state);
    // Equal wins → sort by best lap (Bob 18s beats Ana 25s).
    expect(ranking[0].nickname).toBe('Bob');
    expect(ranking[0].wins).toBe(1);
    expect(ranking[0].podiums).toBe(2);
    expect(ranking[0].races).toBe(2);
    expect(ranking[0].bestLapMs).toBe(18_000);
    expect(ranking[0].bestLapRounds).toBe(3);
  });

  it('does not store wall-clock bestLapMs for TURNS races', () => {
    const ana = racePlayer({ connectionId: 'a', nickname: 'Ana', finishOrder: 1 });
    const state = createInitialState([ana], 'a');
    state.phase = 'GAME_OVER';
    state.gameMode = 'TURNS';
    state.raceStartedAt = startedAt;
    state.players = [ana];
    updateSessionStats(state);
    const row = state.sessionStats![0];
    expect(row.bestLapMs).toBeUndefined();
    expect(row.bestLapRounds).toBe(5);
  });

  it('ranks higher wins above a faster lap', () => {
    const state = createInitialState([racePlayer()], 'c1');
    state.sessionStats = [
      {
        connectionId: 'a',
        nickname: 'Champ',
        color: '#f00',
        races: 3,
        wins: 3,
        podiums: 3,
        bestLapMs: 90_000,
        bestLapRounds: 20,
      },
      {
        connectionId: 'b',
        nickname: 'Speedy',
        color: '#0f0',
        races: 3,
        wins: 1,
        podiums: 1,
        bestLapMs: 15_000,
        bestLapRounds: 4,
      },
    ];
    expect(buildSessionRanking(state).map((r) => r.nickname)).toEqual(['Champ', 'Speedy']);
  });

  it('remaps session stats when a player reconnects', () => {
    const state = createInitialState([racePlayer()], 'c1');
    state.sessionStats = [
      {
        connectionId: 'old',
        nickname: 'Ana',
        color: '#f00',
        races: 1,
        wins: 1,
        podiums: 1,
        bestLapMs: 20_000,
      },
    ];
    remapSessionStatsConnectionId(state, 'old', 'new');
    expect(state.sessionStats![0].connectionId).toBe('new');
  });

  it('keeps the host able to move after their own socket id changes', () => {
    const host = racePlayer({
      connectionId: 'old-host',
      nickname: 'Nilton',
      finishOrder: undefined,
      isHost: true,
    });
    const bot = racePlayer({
      connectionId: 'ai#ROOM#bot',
      nickname: 'Bot Alfa · Pro',
      color: '#38BDF8',
      joinOrder: 1,
      isHost: false,
      finishOrder: undefined,
    });
    const state = createInitialState([host, bot], 'old-host');
    state.phase = 'GAME_ROUND';
    state.turnOrder = ['ai#ROOM#bot', 'old-host'];
    state.currentTurnIndex = 1;

    expect(canPlayerMove(state, 'old-host')).toBe(true);
    expect(retargetLocalPlayer(state, 'old-host', 'new-host', 'Nilton')).toBe(true);
    expect(state.turnOrder).toEqual(['ai#ROOM#bot', 'new-host']);
    expect(state.hostId).toBe('new-host');
    expect(state.players.find((p) => p.nickname === 'Nilton')?.isHost).toBe(true);
    expect(canPlayerMove(state, 'new-host')).toBe(true);
    expect(canPlayerMove(state, 'old-host')).toBe(false);
    // Same socket again is a no-op, including when the previous id was missed.
    expect(retargetLocalPlayer(state, 'new-host', 'new-host', 'Nilton')).toBe(false);
    expect(retargetLocalPlayer(state, null, 'new-host', 'Nilton')).toBe(false);
  });

  it('retargets a car to the new socket when an AI Lambda rotates', () => {
    const host = racePlayer({ connectionId: 'host', nickname: 'Nilton', finishOrder: undefined });
    const nova = racePlayer({
      connectionId: 'old-nova',
      nickname: 'IA Nova · Pro',
      color: '#22C55E',
      finishOrder: undefined,
    });
    const state = createInitialState([host, nova], 'host');
    state.phase = 'GAME_ROUND';
    state.turnOrder = ['host', 'old-nova'];
    state.currentTurnIndex = 1;
    state.replayLog = [
      {
        seq: 0,
        round: 1,
        connectionId: 'old-nova',
        position: { x: 4, y: 4 },
        velocity: { x: 1, y: 0 },
        isOffTrack: false,
        lap: 2,
      },
    ];

    expect(adoptNicknameConnection(state, 'IA Nova · Pro', 'new-nova')).toBe(true);
    expect(state.turnOrder).toEqual(['host', 'new-nova']);
    expect(state.players.find((p) => p.nickname === 'IA Nova · Pro')?.connectionId).toBe('new-nova');
    expect(state.replayLog![0].connectionId).toBe('new-nova');
    expect(canPlayerMove(state, 'new-nova')).toBe(true);
    expect(canPlayerMove(state, 'old-nova')).toBe(false);
    expect(adoptNicknameConnection(state, 'IA Nova · Pro', 'new-nova')).toBe(false);
  });

  it('remaps replay log when a player reconnects (AI handoff)', () => {
    const state = createInitialState([racePlayer()], 'c1');
    state.replayLog = [
      {
        seq: 0,
        round: 0,
        connectionId: 'old',
        position: { x: 1, y: 1 },
        velocity: { x: 0, y: 0 },
        isOffTrack: false,
        lap: 1,
      },
      {
        seq: 1,
        round: 1,
        connectionId: 'old',
        position: { x: 3, y: 1 },
        velocity: { x: 2, y: 0 },
        isOffTrack: false,
        lap: 1,
      },
      {
        seq: 2,
        round: 1,
        connectionId: 'other',
        position: { x: 2, y: 2 },
        velocity: { x: 1, y: 0 },
        isOffTrack: false,
        lap: 1,
      },
    ];
    remapReplayLogConnectionId(state, 'old', 'new');
    expect(state.replayLog!.map((r) => r.connectionId)).toEqual(['new', 'new', 'other']);
    expect(state.replayLog![1].position).toEqual({ x: 3, y: 1 });
  });

  it('builds per-race deltas for global leaderboard persistence', () => {
    const ana = racePlayer({ connectionId: 'a', nickname: 'Ana', finishOrder: 1 });
    const bob = racePlayer({
      connectionId: 'b',
      nickname: 'Bob',
      color: '#0f0',
      finishOrder: undefined,
      lapTimes: [startedAt + 40_000],
      lapRounds: [9],
    });
    const state = createInitialState([ana, bob], 'a');
    state.gameMode = 'TIMED';
    state.raceStartedAt = startedAt;
    state.players = [ana, bob];

    const deltas = buildRaceStatDeltas(state);
    expect(deltas).toHaveLength(2);
    expect(deltas.find((d) => d.nickname === 'Ana')).toMatchObject({
      races: 1,
      wins: 1,
      podiums: 1,
      bestLapMs: 25_000,
      bestLapRounds: 5,
    });
    expect(deltas.find((d) => d.nickname === 'Bob')).toMatchObject({
      races: 1,
      wins: 0,
      podiums: 0,
      bestLapMs: 40_000,
      bestLapRounds: 9,
    });
  });

  it('omits wall-clock bestLapMs from TURNS race deltas', () => {
    const ana = racePlayer({ connectionId: 'a', nickname: 'Ana', finishOrder: 1 });
    const state = createInitialState([ana], 'a');
    state.gameMode = 'TURNS';
    state.raceStartedAt = startedAt;
    state.players = [ana];
    const delta = buildRaceStatDeltas(state)[0];
    expect(delta.bestLapMs).toBeUndefined();
    expect(delta.bestLapRounds).toBe(5);
  });

  it('excludes Bot / IA pilots from global race deltas', () => {
    const human = racePlayer({ connectionId: 'a', nickname: 'Ana', finishOrder: 1 });
    const bot = racePlayer({
      connectionId: 'b',
      nickname: 'Bot Alfa · Médio',
      color: '#0f0',
      finishOrder: 2,
    });
    const ia = racePlayer({
      connectionId: 'c',
      nickname: 'IA Nova · Pro',
      color: '#00f',
      finishOrder: 3,
    });
    const state = createInitialState([human, bot, ia], 'a');
    state.gameMode = 'TIMED';
    state.raceStartedAt = startedAt;
    state.players = [human, bot, ia];
    const deltas = buildRaceStatDeltas(state);
    expect(deltas.map((d) => d.nickname)).toEqual(['Ana']);
  });
});

describe('global leaderboard rank keys', () => {
  it('normalizes nicknames case-insensitively', () => {
    expect(nicknameKey('  Ana ')).toBe('ana');
  });

  it('orders higher wins before lower wins (ascending rankKey)', () => {
    const high = buildRankKey(5, 30_000, 8, 'ana');
    const low = buildRankKey(2, 10_000, 3, 'bob');
    expect(high < low).toBe(true);
  });

  it('with equal wins, prefers lower best-lap time', () => {
    const faster = buildRankKey(3, 20_000, 9, 'zoe');
    const slower = buildRankKey(3, 40_000, 4, 'amy');
    expect(faster < slower).toBe(true);
  });

  it('with equal wins and time, prefers fewer rounds', () => {
    const fewer = buildRankKey(3, 20_000, 4, 'zoe');
    const more = buildRankKey(3, 20_000, 8, 'amy');
    expect(fewer < more).toBe(true);
  });

  it('missing bests sort after real bests for the same wins', () => {
    const withBest = buildRankKey(2, 50_000, 10, 'ana');
    const without = buildRankKey(2, undefined, undefined, 'bob');
    expect(withBest < without).toBe(true);
  });
});

describe('compareLeaderboardEntries', () => {
  it('sorts by wins, then best lap time, then rounds, then name', () => {
    const rows = [
      { nickname: 'slow-champ', wins: 5, bestLapMs: 90_000, bestLapRounds: 20 },
      { nickname: 'fast-rookie', wins: 1, bestLapMs: 15_000, bestLapRounds: 4 },
      { nickname: 'same-wins-slower', wins: 5, bestLapMs: 60_000, bestLapRounds: 10 },
      { nickname: 'same-wins-faster', wins: 5, bestLapMs: 40_000, bestLapRounds: 12 },
      { nickname: 'same-time-fewer-r', wins: 5, bestLapMs: 40_000, bestLapRounds: 8 },
    ];
    rows.sort(compareLeaderboardEntries);
    expect(rows.map((r) => r.nickname)).toEqual([
      'same-time-fewer-r', // 5 wins, 40s, 8r
      'same-wins-faster', // 5 wins, 40s, 12r
      'same-wins-slower', // 5 wins, 60s
      'slow-champ', // 5 wins, 90s
      'fast-rookie', // 1 win
    ]);
  });

  it('ignores absurd legacy wall-clock "laps" when comparing', () => {
    const rows = [
      { nickname: 'turns-junk', wins: 2, bestLapMs: 12 * 60 * 1000, bestLapRounds: 8 },
      { nickname: 'timed-real', wins: 2, bestLapMs: 45_000, bestLapRounds: 10 },
    ];
    rows.sort(compareLeaderboardEntries);
    expect(rows.map((r) => r.nickname)).toEqual(['timed-real', 'turns-junk']);
  });
});

function rectsOverlap(
  a: { x0: number; y0: number; x1: number; y1: number },
  b: { x0: number; y0: number; x1: number; y1: number }
): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}

function makeDrsTrack(): TrackDefinition {
  const grid = Array.from({ length: 20 }, () =>
    Array.from({ length: 40 }, () => 'track' as const)
  ) as TrackDefinition['grid'];
  return {
    id: 'drs-test',
    nameKey: 'tracks.test',
    width: 40,
    height: 20,
    grid,
    startLine: [{ x: 1, y: 5 }],
    arrows: [],
    centerline: [
      { x: 0, y: 5 },
      { x: 39, y: 5 },
      { x: 0, y: 5 },
    ],
    checkpoint: { x0: 0, y0: 0, x1: 0, y1: 0 },
    drsZones: [
      { x0: 10, y0: 4, x1: 12, y1: 6 },
      { x0: 22, y0: 4, x1: 24, y1: 6 },
    ],
  };
}

describe('DRS and ERS', () => {
  it('rejects gear 7 without DRS, allows it while DRS is open, and never allows gear 8', () => {
    expect(isValidGearChange({ x: 6, y: 0 }, { x: 7, y: 0 }, false)).toBe(false);
    expect(isValidGearChange({ x: 6, y: 0 }, { x: 7, y: 0 }, false, 1, DRS_MAX_GEAR)).toBe(true);
    expect(isValidGearChange({ x: 7, y: 0 }, { x: 8, y: 0 }, false, 1, DRS_MAX_GEAR)).toBe(false);
    expect(isValidGearChange({ x: 6, y: 0 }, { x: 8, y: 0 }, false, ERS_MAX_DELTA, DRS_MAX_GEAR)).toBe(
      false
    );

    const track = makeDrsTrack();
    const coasting = makePlayer({ position: { x: 10, y: 10 }, velocity: { x: 6, y: 0 } });
    const plain = getValidMoves(coasting, track);
    expect(plain.some((m) => m.velocity.x === 7 && m.velocity.y === 0)).toBe(false);

    const open = makePlayer({
      position: { x: 10, y: 10 },
      velocity: { x: 6, y: 0 },
      drsActive: true,
    });
    const limits = boostLimits(open, 1, {});
    expect(limits.maxGear).toBe(DRS_MAX_GEAR);
    const withDrs = getValidMoves(open, track, undefined, 1, limits.maxGear, limits.maxDelta);
    expect(withDrs.some((m) => m.velocity.x === 7 && m.velocity.y === 0)).toBe(true);
    expect(withDrs.some((m) => m.velocity.x === 8)).toBe(false);
  });

  it('arms a zone only for an unfinished rival ahead within Chebyshev 3', () => {
    const track = makeDrsTrack();
    const from = { x: 8, y: 5 };
    const landing = { x: 11, y: 5 };

    const aheadNear = makePlayer({
      connectionId: 'rival',
      nickname: 'Bea',
      isHost: false,
      position: { x: 8, y: 5 },
      lap: 1,
    });
    const me = makePlayer({ position: from, lap: 1 });
    armDrsZones(me, from, landing, [me, aheadNear], track);
    expect(me.drsArmed).toBe(true);
    expect(me.drsZonesUsed).toEqual([0]);

    const tooFar = makePlayer({ position: from, lap: 1 });
    const aheadFar = makePlayer({
      connectionId: 'rival',
      nickname: 'Bea',
      isHost: false,
      position: { x: 7, y: 5 },
      lap: 1,
    });
    armDrsZones(tooFar, from, landing, [tooFar, aheadFar], track);
    expect(tooFar.drsArmed).toBeUndefined();
    expect(tooFar.drsZonesUsed).toBeUndefined();

    const behindMe = makePlayer({ position: from, lap: 1 });
    const behind = makePlayer({
      connectionId: 'rival',
      nickname: 'Bea',
      isHost: false,
      position: { x: 14, y: 5 },
      lap: 1,
    });
    armDrsZones(behindMe, from, landing, [behindMe, behind], track);
    expect(behindMe.drsArmed).toBeUndefined();
  });

  it('spends a zone for the lap, arms the next one, and clears the list on the following lap', () => {
    const track = makeDrsTrack();
    const rival = makePlayer({
      connectionId: 'rival',
      nickname: 'Bea',
      isHost: false,
      position: { x: 8, y: 5 },
      lap: 1,
    });
    const me = makePlayer({ position: { x: 8, y: 5 }, lap: 1 });
    armDrsZones(me, { x: 8, y: 5 }, { x: 11, y: 5 }, [me, rival], track);
    expect(me.drsZonesUsed).toEqual([0]);

    me.drsArmed = false;
    armDrsZones(me, { x: 11, y: 5 }, { x: 11, y: 5 }, [me, rival], track);
    expect(me.drsArmed).toBe(false);
    expect(me.drsZonesUsed).toEqual([0]);

    rival.position = { x: 20, y: 5 };
    armDrsZones(me, { x: 20, y: 5 }, { x: 23, y: 5 }, [me, rival], track);
    expect(me.drsArmed).toBe(true);
    expect(me.drsZonesUsed).toEqual([0, 1]);

    me.passedCheckpoint = true;
    beginNextLap(me);
    expect(me.passedCheckpoint).toBe(false);
    expect(me.drsZonesUsed).toEqual([]);
  });

  it('keeps DRS open while the gear holds or rises, and closes it when the gear falls', () => {
    const player = makePlayer({
      velocity: { x: 4, y: 0 },
      drsActive: true,
      drsArmed: true,
      ersCharge: 0,
    });
    settleBoostFromGears(player, 4, 4);
    expect(player.drsActive).toBe(true);
    expect(player.ersCharge).toBe(0);

    settleBoostFromGears(player, 4, 6);
    expect(player.drsActive).toBe(true);
    expect(player.drsArmed).toBe(true);

    settleBoostFromGears(player, 6, 5);
    expect(player.drsActive).toBe(false);
    expect(player.drsArmed).toBe(false);
    expect(player.ersCharge).toBe(0.25);

    const stopped = makePlayer({
      velocity: { x: 4, y: 0 },
      drsActive: true,
      drsArmed: false,
      ersCharge: 0,
    });
    settleBoostFromGears(stopped, 4, 0);
    expect(stopped.drsActive).toBe(false);
    expect(stopped.ersCharge).toBe(1);
  });

  it('recharges ERS only on a gear drop, in quarter bars, capped at 4', () => {
    const one = makePlayer({ ersCharge: 0 });
    settleBoostFromGears(one, 3, 2);
    expect(one.ersCharge).toBe(0.25);

    const four = makePlayer({ ersCharge: 0 });
    settleBoostFromGears(four, 4, 0);
    expect(four.ersCharge).toBe(1);

    const steps = makePlayer({ ersCharge: 0 });
    let gear = 4;
    for (let i = 0; i < 4; i++) {
      settleBoostFromGears(steps, gear, gear - 1);
      gear -= 1;
    }
    expect(steps.ersCharge).toBe(1);

    const held = makePlayer({ ersCharge: 1 });
    settleBoostFromGears(held, 2, 3);
    settleBoostFromGears(held, 3, 3);
    expect(held.ersCharge).toBe(1);

    const full = makePlayer({ ersCharge: 3.75 });
    settleBoostFromGears(full, 4, 0);
    expect(full.ersCharge).toBe(ERS_MAX_CHARGE);
  });

  it('allows a one-gear skip with ERS and spends exactly one bar', () => {
    const track = makeDrsTrack();
    const player = makePlayer({
      position: { x: 10, y: 10 },
      velocity: { x: 3, y: 0 },
      ersCharge: 1.25,
    });
    const limits = boostLimits(player, 1, { ers: true });
    expect(limits.maxDelta).toBe(ERS_MAX_DELTA);
    expect(limits.spendErs).toBe(true);
    expect(isValidGearChange(player.velocity, { x: 5, y: 0 }, false, limits.maxDelta, limits.maxGear)).toBe(
      true
    );
    expect(
      isValidGearChange(player.velocity, { x: 6, y: 0 }, false, limits.maxDelta, limits.maxGear)
    ).toBe(false);

    const moves = getValidMoves(player, track, undefined, 1, limits.maxGear, limits.maxDelta);
    expect(moves.map((m) => m.velocity).sort((a, b) => a.y - b.y)).toEqual([
      { x: 5, y: -1 },
      { x: 5, y: 0 },
      { x: 5, y: 1 },
    ]);
    const plain = getValidMoves(player, track);
    expect(plain.some((m) => m.velocity.x === 5 && m.velocity.y === 0)).toBe(false);

    spendErsIfAccepted(player, limits);
    expect(player.ersCharge).toBe(0.25);

    const rejected = makePlayer({ ersCharge: 2 });
    const refused = boostLimits(rejected, 1, { ers: true });
    expect(
      isValidGearChange(rejected.velocity, { x: 3, y: 0 }, false, refused.maxDelta, refused.maxGear)
    ).toBe(false);
    expect(rejected.ersCharge).toBe(2);
  });

  it('spends ERS only forward, on one line, and never as a brake', () => {
    expect(ersForwardDeltas({ x: 4, y: 0 })).toEqual([
      { x: 2, y: -1 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
    ]);
    expect(ersForwardDeltas({ x: 0, y: -3 })).toEqual([
      { x: -1, y: -2 },
      { x: 0, y: -2 },
      { x: 1, y: -2 },
    ]);
    expect(ersForwardDeltas({ x: -4, y: 0 })).toEqual([
      { x: -2, y: 1 },
      { x: -2, y: 0 },
      { x: -2, y: -1 },
    ]);
    expect(ersForwardDeltas({ x: 2, y: 2 })).toEqual([
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 1, y: 2 },
    ]);
    expect(ersForwardDeltas({ x: 0, y: 0 })).toEqual([]);

    expect(isValidGearChange({ x: 3, y: 0 }, { x: 5, y: 1 }, false, ERS_MAX_DELTA, 6)).toBe(true);
    expect(isValidGearChange({ x: 3, y: 0 }, { x: 1, y: 0 }, false, ERS_MAX_DELTA, 6)).toBe(false);
    expect(isValidGearChange({ x: 3, y: 0 }, { x: 5, y: 2 }, false, ERS_MAX_DELTA, 6)).toBe(false);
    expect(isValidGearChange({ x: 3, y: 0 }, { x: 4, y: 0 }, false, ERS_MAX_DELTA, 6)).toBe(false);
    expect(isValidGearChange({ x: 2, y: 2 }, { x: 4, y: 4 }, false, ERS_MAX_DELTA, 6)).toBe(true);
    expect(isValidGearChange({ x: 2, y: 2 }, { x: 4, y: 2 }, false, ERS_MAX_DELTA, 6)).toBe(false);

    const track = makeDrsTrack();
    const stopped = makePlayer({ position: { x: 10, y: 10 }, velocity: { x: 0, y: 0 }, ersCharge: 2 });
    expect(getValidMoves(stopped, track, undefined, 1, 6, ERS_MAX_DELTA)).toEqual([]);

    const diagonal = makePlayer({ position: { x: 10, y: 10 }, velocity: { x: 2, y: 2 }, ersCharge: 1 });
    const diagonalMoves = getValidMoves(diagonal, track, undefined, 1, 6, ERS_MAX_DELTA);
    expect(diagonalMoves.map((m) => `${m.velocity.x},${m.velocity.y}`).sort()).toEqual([
      '3,4',
      '4,3',
      '4,4',
    ]);
  });

  it('with DRS and ERS together reaches gear 7 from 5, and not 8', () => {
    const player = makePlayer({
      position: { x: 10, y: 10 },
      velocity: { x: 5, y: 0 },
      drsArmed: true,
      ersCharge: 1,
    });
    const beforeActive = player.drsActive;
    const beforeArmed = player.drsArmed;
    const limits = engageRequestedDrs(player, 1, { drs: true, ers: true });
    expect(player.drsActive).toBe(true);
    expect(player.drsArmed).toBe(false);
    expect(limits.maxGear).toBe(DRS_MAX_GEAR);
    expect(limits.maxDelta).toBe(ERS_MAX_DELTA);
    expect(isValidGearChange({ x: 5, y: 0 }, { x: 7, y: 0 }, false, limits.maxDelta, limits.maxGear)).toBe(
      true
    );
    expect(isValidGearChange({ x: 5, y: 0 }, { x: 8, y: 0 }, false, limits.maxDelta, limits.maxGear)).toBe(
      false
    );

    const track = makeDrsTrack();
    const moves = getValidMoves(player, track, undefined, 1, limits.maxGear, limits.maxDelta);
    expect(moves.some((m) => m.velocity.x === 7 && m.velocity.y === 0)).toBe(true);
    expect(moves.some((m) => gearOf(m.velocity) === 8)).toBe(false);

    revertDrsOpen(player, beforeActive, beforeArmed);
    expect(player.drsActive).toBeUndefined();
    expect(player.drsArmed).toBe(true);
    expect(player.ersCharge).toBe(1);
  });

  it('does not let DRS or ERS raise the gear-1 cap', () => {
    const track = makeDrsTrack();
    const off = makePlayer({
      position: { x: 10, y: 10 },
      velocity: { x: 0, y: 0 },
      isOffTrack: true,
      drsArmed: true,
      drsActive: true,
      ersCharge: 4,
    });
    const offLimits = boostLimits(off, 1, { drs: true, ers: true });
    expect(offLimits.maxGear).toBe(1);
    expect(offLimits.maxDelta).toBe(1);
    expect(offLimits.openDrs).toBe(false);
    expect(offLimits.spendErs).toBe(false);
    const offMoves = getValidMoves(off, track, undefined, 1, DRS_MAX_GEAR, ERS_MAX_DELTA);
    expect(offMoves.every((m) => [-1, 0, 1].includes(m.velocity.x) && [-1, 0, 1].includes(m.velocity.y))).toBe(
      true
    );
    expect(isValidGearChange({ x: 0, y: 0 }, { x: 2, y: 0 }, true, ERS_MAX_DELTA, DRS_MAX_GEAR)).toBe(false);
    expect(isValidGearChange({ x: 0, y: 0 }, { x: 1, y: 1 }, true, ERS_MAX_DELTA, DRS_MAX_GEAR)).toBe(true);

    const penalized = makePlayer({
      position: { x: 10, y: 10 },
      velocity: { x: 1, y: 0 },
      gearPenaltyUntilRound: 4,
      drsArmed: true,
      ersCharge: 2,
    });
    const penLimits = boostLimits(penalized, 4, { drs: true, ers: true });
    expect(penLimits.maxGear).toBe(1);
    expect(penLimits.maxDelta).toBe(1);
    const penMoves = getValidMoves(penalized, track, undefined, 4, DRS_MAX_GEAR, ERS_MAX_DELTA);
    expect(penMoves.every((m) => [-1, 0, 1].includes(m.velocity.x) && [-1, 0, 1].includes(m.velocity.y))).toBe(
      true
    );
    expect(penMoves.some((m) => m.velocity.x === 2)).toBe(false);
  });

  it('opens DRS before the gear check and closes it if that same move brakes', () => {
    const player = makePlayer({ velocity: { x: 4, y: 0 }, drsArmed: true, ersCharge: 0 });
    const limits = engageRequestedDrs(player, 1, { drs: true });
    expect(limits.maxGear).toBe(DRS_MAX_GEAR);
    expect(player.drsActive).toBe(true);
    expect(
      isValidGearChange(player.velocity, { x: 3, y: 0 }, false, limits.maxDelta, limits.maxGear)
    ).toBe(true);
    settleBoostFromGears(player, 4, 3);
    expect(player.drsActive).toBe(false);
    expect(player.drsArmed).toBe(false);
    expect(player.ersCharge).toBe(0.25);
  });

  it('places one DRS zone on each circuit, off the stripe and off the lap checkpoint', () => {
    for (const track of TRACKS) {
      expect(track.drsZones).toHaveLength(1);
      const zone = track.drsZones![0];
      expect(track.checkpoint).toBeDefined();
      expect(rectsOverlap(zone, track.checkpoint!)).toBe(false);

      let coversFinish = false;
      let coversAsphalt = false;
      for (let y = zone.y0; y <= zone.y1; y++) {
        for (let x = zone.x0; x <= zone.x1; x++) {
          const tile = track.grid[y]?.[x];
          if (tile === 'finish') coversFinish = true;
          if (tile === 'track' || tile === 'finish') coversAsphalt = true;
        }
      }
      expect(coversFinish).toBe(false);
      expect(coversAsphalt).toBe(true);
    }
  });
});
