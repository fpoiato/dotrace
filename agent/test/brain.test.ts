import { createInitialState, createLobbyPlayer } from '../../shared/ws-types';
import { getTrackById } from '../../shared/tracks';
import { BedrockBrain, ConverseClient, HeuristicBrain } from '../src/brain';
import { buildBoardSummary, listAnnotatedMoves } from '../src/tools';
import type { AnnotatedMove, BoardSummary } from '../src/tools';

const track = getTrackById('monza')!;

function fixtures(): { summary: BoardSummary; moves: AnnotatedMove[] } {
  const me = createLobbyPlayer('ai-1', 'AI Pilot', false, 1, '#3B82F6');
  me.position = { x: 12, y: 28 };
  me.velocity = { x: 1, y: 0 };

  const state = createInitialState([me], 'ai-1');
  state.phase = 'GAME_ROUND';
  state.trackId = track.id;
  state.turnOrder = ['ai-1'];
  state.round = 1;
  state.totalLaps = 1;

  return {
    summary: buildBoardSummary(me, state, track),
    moves: listAnnotatedMoves(me, state, track),
  };
}

function stubClient(responseText: string | Error): ConverseClient {
  return {
    send: () => {
      if (responseText instanceof Error) return Promise.reject(responseText);
      return Promise.resolve({
        output: { message: { content: [{ text: responseText }] } },
      });
    },
  };
}

describe('HeuristicBrain', () => {
  it('always returns a move from the legal list', async () => {
    const { summary, moves } = fixtures();
    const chosen = await new HeuristicBrain().pickMove(summary, moves);
    expect(moves).toContain(chosen);
  });

  it('avoids grass shortcuts when a clean move exists', async () => {
    const { summary, moves } = fixtures();
    const chosen = await new HeuristicBrain().pickMove(summary, moves);
    if (moves.some((m) => !m.grassShortcut)) {
      expect(chosen.grassShortcut).toBe(false);
    }
  });
});

describe('BedrockBrain', () => {
  const options = { modelId: 'amazon.nova-micro-v1:0', region: 'us-east-1' };

  it('uses the model-selected move when the index is valid', async () => {
    const { summary, moves } = fixtures();
    const brain = new BedrockBrain({
      ...options,
      client: stubClient('{"moveIndex": 2}'),
    });
    const chosen = await brain.pickMove(summary, moves);
    expect(chosen).toBe(moves[2]);
  });

  it('parses JSON wrapped in prose or fences', async () => {
    const { summary, moves } = fixtures();
    const brain = new BedrockBrain({
      ...options,
      client: stubClient('Best option:\n```json\n{"moveIndex": 1}\n```'),
    });
    const chosen = await brain.pickMove(summary, moves);
    expect(chosen).toBe(moves[1]);
  });

  it('falls back to heuristic on out-of-range index', async () => {
    const { summary, moves } = fixtures();
    const brain = new BedrockBrain({
      ...options,
      client: stubClient('{"moveIndex": 999}'),
    });
    const chosen = await brain.pickMove(summary, moves);
    expect(moves).toContain(chosen);
  });

  it('falls back to heuristic on malformed output', async () => {
    const { summary, moves } = fixtures();
    const brain = new BedrockBrain({
      ...options,
      client: stubClient('turn left!'),
    });
    const chosen = await brain.pickMove(summary, moves);
    expect(moves).toContain(chosen);
  });

  it('falls back to heuristic when Bedrock throws (throttle, auth, offline)', async () => {
    const { summary, moves } = fixtures();
    const brain = new BedrockBrain({
      ...options,
      client: stubClient(new Error('ThrottlingException')),
    });
    const chosen = await brain.pickMove(summary, moves);
    expect(moves).toContain(chosen);
  });

  it('skips the model entirely when only one legal move exists', async () => {
    const { summary, moves } = fixtures();
    const single = [moves[0]];
    const brain = new BedrockBrain({
      ...options,
      client: stubClient(new Error('should never be called')),
    });
    const chosen = await brain.pickMove(summary, single);
    expect(chosen).toBe(single[0]);
  });
});
