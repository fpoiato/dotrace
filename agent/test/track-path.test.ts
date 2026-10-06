import { getTrackById } from '../../shared/tracks';
import { createInitialState, createLobbyPlayer } from '../../shared/ws-types';
import { HeuristicBrain } from '../src/brain';
import {
  asphaltLookahead,
  buildDistanceField,
  describeTrackSituation,
  isAsphalt,
  pathDistance,
  segmentGoals,
} from '../src/track-path';
import { buildBoardSummary, listAnnotatedMoves } from '../src/tools';

const track = getTrackById('monza')!;

describe('track path field', () => {
  it('builds a directed distance field that prefers race direction', () => {
    const goals = segmentGoals(track, false);
    expect(goals.length).toBeGreaterThan(0);

    const field = buildDistanceField(track, goals);
    const onStraight = pathDistance(field, { x: 150, y: 118 });
    const furtherAlong = pathDistance(field, { x: 130, y: 118 });
    // Going the correct way (left along the bottom straight) reduces remaining distance.
    expect(furtherAlong).toBeLessThan(onStraight);
    // Grass next to the track is unreachable in the asphalt field.
    expect(pathDistance(field, { x: 150, y: 108 })).toBe(Number.POSITIVE_INFINITY);
  });

  it('lookahead is long on the bottom straight and short into Parabolica', () => {
    expect(isAsphalt(track, { x: 150, y: 118 })).toBe(true);
    const straight = asphaltLookahead(track, { x: 150, y: 118 }, { x: -3, y: 0 });
    const intoCorner = asphaltLookahead(track, { x: 86, y: 118 }, { x: -3, y: 0 });
    expect(straight).toBeGreaterThanOrEqual(4);
    expect(intoCorner).toBeLessThan(straight);
  });

  it('describes where the car is on the directed racing line', () => {
    const onStraight = describeTrackSituation(
      track,
      { x: 150, y: 118 },
      { x: -2, y: 0 },
      false
    );
    expect(onStraight.trackId).toBe('monza');
    expect(onStraight.alignment).toBe('with_traffic');
    expect(onStraight.lapProgressPct).toBeGreaterThan(0);
    expect(onStraight.cellsToGoal).toBeGreaterThan(10);
    expect(onStraight.ahead.length).toBeGreaterThan(0);
    expect(onStraight.suggestedMaxGear).toBeGreaterThanOrEqual(1);

    const wrongWay = describeTrackSituation(
      track,
      { x: 150, y: 118 },
      { x: 2, y: 0 },
      false
    );
    expect(wrongWay.alignment).toBe('against');
  });
});

describe('HeuristicBrain track awareness', () => {
  it('accelerates on a clear straight when gear is low', async () => {
    const me = createLobbyPlayer('ai-1', 'AI Pilot', false, 1, '#3B82F6');
    me.position = { x: 150, y: 118 };
    me.velocity = { x: -1, y: 0 };
    me.passedCheckpoint = false;

    const state = createInitialState([me], 'ai-1');
    state.phase = 'GAME_ROUND';
    state.trackId = track.id;
    state.turnOrder = ['ai-1'];
    state.round = 1;
    state.totalLaps = 1;

    const summary = buildBoardSummary(me, state, track);
    const moves = listAnnotatedMoves(me, state, track);
    const chosen = await new HeuristicBrain().pickMove(summary, moves);

    expect(chosen.grassShortcut).toBe(false);
    expect(chosen.gear).toBeGreaterThan(1);
    expect(chosen.pathProgress).toBeGreaterThan(0);
  });

  it('prefers braking (or not accelerating) when high gear meets a short runway', async () => {
    const me = createLobbyPlayer('ai-1', 'AI Pilot', false, 1, '#3B82F6');
    // Near the end of the bottom straight, heading into the Rettifilo.
    me.position = { x: 96, y: 118 };
    me.velocity = { x: -4, y: 0 };
    me.passedCheckpoint = false;

    const state = createInitialState([me], 'ai-1');
    state.phase = 'GAME_ROUND';
    state.trackId = track.id;
    state.turnOrder = ['ai-1'];
    state.round = 1;
    state.totalLaps = 1;

    const summary = buildBoardSummary(me, state, track);
    const moves = listAnnotatedMoves(me, state, track);
    const chosen = await new HeuristicBrain().pickMove(summary, moves);

    expect(chosen.grassShortcut).toBe(false);
    // Should not keep climbing into the wall.
    expect(chosen.gear).toBeLessThanOrEqual(4);
    const faster = moves.filter((m) => m.gear > chosen.gear && !m.grassShortcut);
    // If a faster clean move exists, it must have worse path/clear metrics.
    for (const m of faster) {
      expect(m.clearAhead + m.pathProgress).toBeLessThanOrEqual(
        chosen.clearAhead + chosen.pathProgress + 2
      );
    }
  });

  it('makes path progress along the corridor, not Euclidean grass cuts', async () => {
    const me = createLobbyPlayer('ai-1', 'AI Pilot', false, 1, '#3B82F6');
    me.position = { x: 150, y: 118 };
    me.velocity = { x: -2, y: 0 };
    me.passedCheckpoint = false;

    const state = createInitialState([me], 'ai-1');
    state.phase = 'GAME_ROUND';
    state.trackId = track.id;
    state.turnOrder = ['ai-1'];
    state.round = 1;
    state.totalLaps = 1;

    const summary = buildBoardSummary(me, state, track);
    const moves = listAnnotatedMoves(me, state, track);
    const chosen = await new HeuristicBrain().pickMove(summary, moves);

    expect(chosen.grassShortcut).toBe(false);
    expect(Number.isFinite(chosen.pathDistance)).toBe(true);
    expect(chosen.pathProgress).toBeGreaterThan(0);
    expect(chosen.velocity.x).toBeLessThan(0);
  });
});
