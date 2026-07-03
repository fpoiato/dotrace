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
  getValidMoves,
  isGameOver,
  isValidGearChange,
  nextActiveTurnIndex,
  rollDice,
  generateRoomCode,
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
      diceRolls: {},
      podium: [{ connectionId: 'c2', nickname: 'Bia', position: 1 }],
    };
    expect(isGameOver(state)).toBe(false);
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
