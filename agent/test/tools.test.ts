import {
  createInitialState,
  createLobbyPlayer,
  getValidMoves,
} from '../../shared/ws-types';
import { getTrackById } from '../../shared/tracks';
import {
  buildBoardSummary,
  goalPoint,
  isMoveInList,
  listAnnotatedMoves,
} from '../src/tools';

const track = getTrackById('monza')!;

function raceState() {
  const me = createLobbyPlayer('ai-1', 'AI Pilot', false, 2, '#3B82F6');
  me.position = { x: 12, y: 28 };
  me.velocity = { x: 0, y: 0 };
  const host = createLobbyPlayer('host-1', 'Host', true, 1, '#EF4444');
  host.position = { x: 14, y: 28 };

  const state = createInitialState([host, me], 'host-1');
  state.phase = 'GAME_ROUND';
  state.trackId = track.id;
  state.turnOrder = ['host-1', 'ai-1'];
  state.currentTurnIndex = 1;
  state.round = 1;
  state.totalLaps = 1;
  return { state, me };
}

describe('listAnnotatedMoves', () => {
  it('mirrors getValidMoves exactly (same velocities, stable indexes)', () => {
    const { state, me } = raceState();
    const annotated = listAnnotatedMoves(me, state, track);
    const valid = getValidMoves(me, track, state.players, state.round);

    expect(annotated).toHaveLength(valid.length);
    annotated.forEach((move, i) => {
      expect(move.index).toBe(i);
      expect(move.velocity).toEqual(valid[i].velocity);
      expect(move.landing).toEqual(valid[i].landing);
    });
  });

  it('annotates landing tiles and distances', () => {
    const { state, me } = raceState();
    const moves = listAnnotatedMoves(me, state, track);

    for (const move of moves) {
      expect(['track', 'grass', 'finish', 'rumble', 'void']).toContain(move.landingTile);
      expect(move.distanceToGoal).toBeGreaterThanOrEqual(0);
      expect(move.gear).toBeGreaterThanOrEqual(0);
    }
  });

  it('excludes squares occupied by opponents', () => {
    const { state, me } = raceState();
    const opponent = state.players.find((p) => p.connectionId === 'host-1')!;
    // Host sits directly on one of our potential landing squares.
    opponent.position = { x: 13, y: 28 };

    const moves = listAnnotatedMoves(me, state, track);
    expect(
      moves.some((m) => m.landing.x === 13 && m.landing.y === 28)
    ).toBe(false);
  });
});

describe('goalPoint', () => {
  it('targets the checkpoint before it is passed, then the finish', () => {
    const { me } = raceState();
    expect(track.checkpoint).toBeDefined();

    me.passedCheckpoint = false;
    expect(goalPoint(me, track).goal).toBe('checkpoint');

    me.passedCheckpoint = true;
    expect(goalPoint(me, track).goal).toBe('finish');
  });
});

describe('buildBoardSummary', () => {
  it('summarizes my car and opponents without leaking my own record', () => {
    const { state, me } = raceState();
    const summary = buildBoardSummary(me, state, track);

    expect(summary.position).toEqual(me.position);
    expect(summary.lap).toBe(1);
    expect(summary.totalLaps).toBe(1);
    expect(summary.goal).toBe('checkpoint');
    expect(summary.opponents).toHaveLength(1);
    expect(summary.opponents[0].nickname).toBe('Host');
  });
});

describe('isMoveInList', () => {
  it('accepts only enumerated velocities', () => {
    const { state, me } = raceState();
    const moves = listAnnotatedMoves(me, state, track);

    expect(isMoveInList(moves, moves[0].velocity)).toBe(true);
    expect(isMoveInList(moves, { x: 99, y: 99 })).toBe(false);
  });
});
