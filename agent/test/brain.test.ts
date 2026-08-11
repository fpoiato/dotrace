import { createInitialState, createLobbyPlayer } from '../../shared/ws-types';
import { getTrackById } from '../../shared/tracks';
import {
  BedrockBrain,
  ConverseClient,
  HeuristicBrain,
  isDominatedByHeuristic,
} from '../src/brain';
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

function hangingClient(delayMs: number): ConverseClient {
  return {
    send: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({ output: { message: { content: [{ text: '{"moveIndex":0}' }] } } });
        }, delayMs);
      }),
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

  it('does not stand still when a moving legal option exists', async () => {
    const { summary, moves } = fixtures();
    const chosen = await new HeuristicBrain().pickMove(summary, moves);
    expect(chosen.velocity.x !== 0 || chosen.velocity.y !== 0).toBe(true);
  });

  it('gives different styles to different nicknames so twin bots diverge', async () => {
    // Approaching Parabolica: aggression vs caution trade off (brake vs turn-in).
    const me = createLobbyPlayer('ai-1', 'AI Pilot', false, 1, '#3B82F6');
    me.position = { x: 68, y: 48 };
    me.velocity = { x: 3, y: 0 };
    const state = createInitialState([me], 'ai-1');
    state.phase = 'GAME_ROUND';
    state.trackId = track.id;
    state.turnOrder = ['ai-1'];
    state.round = 1;
    state.totalLaps = 1;
    const summary = buildBoardSummary(me, state, track);
    const moves = listAnnotatedMoves(me, state, track);

    const a = await new HeuristicBrain('Bot Alfa').pickMove(summary, moves);
    const b = await new HeuristicBrain('Bot Turbo').pickMove(summary, moves);
    expect(`${a.velocity.x},${a.velocity.y}`).not.toBe(`${b.velocity.x},${b.velocity.y}`);
  });

  it('caps easy gear softer than pro on an open straight', async () => {
    const me = createLobbyPlayer('ai-1', 'AI Pilot', false, 1, '#3B82F6');
    me.position = { x: 20, y: 28 };
    me.velocity = { x: 2, y: 0 };
    const state = createInitialState([me], 'ai-1');
    state.phase = 'GAME_ROUND';
    state.trackId = track.id;
    state.turnOrder = ['ai-1'];
    state.round = 1;
    state.totalLaps = 1;
    const summary = buildBoardSummary(me, state, track);
    const moves = listAnnotatedMoves(me, state, track);

    const seed = 'Bot Straight';
    const easy = await new HeuristicBrain({ styleOrSeed: seed, difficulty: 'easy' }).pickMove(
      summary,
      moves
    );
    const pro = await new HeuristicBrain({ styleOrSeed: seed, difficulty: 'pro' }).pickMove(
      summary,
      moves
    );
    expect(easy.gear).toBeLessThanOrEqual(3);
    expect(pro.gear).toBeGreaterThanOrEqual(easy.gear);
  });

  it('pro always picks the top score while easy can take a near-best', async () => {
    const { summary, moves } = fixtures();
    const seed = 'Bot Mistake';
    const proBrain = new HeuristicBrain({ styleOrSeed: seed, difficulty: 'pro' });
    const easyBrain = new HeuristicBrain({ styleOrSeed: seed, difficulty: 'easy' });
    expect(proBrain.difficulty).toBe('pro');
    expect(easyBrain.difficulty).toBe('easy');
    expect(easyBrain.moveDelayMs).toBeGreaterThan(proBrain.moveDelayMs);

    const pro = await proBrain.pickMove(summary, moves);
    const easy = await easyBrain.pickMove(summary, moves);
    expect(moves).toContain(pro);
    expect(moves).toContain(easy);
    // Same seed + different mistakeChance: when easy rolls a mistake it may
    // diverge; either way both stay legal and non-stationary.
    expect(easy.velocity.x !== 0 || easy.velocity.y !== 0).toBe(true);
    expect(pro.grassShortcut).toBe(false);
  });
});

describe('BedrockBrain', () => {
  const options = { modelId: 'amazon.nova-micro-v1:0', region: 'us-east-1' };

  it('uses the model-selected move when it matches / beats the heuristic floor', async () => {
    const { summary, moves } = fixtures();
    const heuristic = await new HeuristicBrain('AI Pilot').pickMove(summary, moves);
    const brain = new BedrockBrain({
      ...options,
      fallbackSeed: 'AI Pilot',
      client: stubClient(JSON.stringify({ moveIndex: heuristic.index })),
    });
    const chosen = await brain.pickMove(summary, moves);
    expect(chosen).toBe(moves[heuristic.index]);
  });

  it('parses JSON wrapped in prose or fences', async () => {
    const { summary, moves } = fixtures();
    const heuristic = await new HeuristicBrain('AI Pilot').pickMove(summary, moves);
    const brain = new BedrockBrain({
      ...options,
      fallbackSeed: 'AI Pilot',
      client: stubClient(`Best option:\n\`\`\`json\n{"moveIndex": ${heuristic.index}}\n\`\`\``),
    });
    const chosen = await brain.pickMove(summary, moves);
    expect(chosen).toBe(moves[heuristic.index]);
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

  it('falls back to heuristic when the model picks standstill with motion available', async () => {
    const { summary, moves } = fixtures();
    const zeroIdx = moves.findIndex((m) => m.velocity.x === 0 && m.velocity.y === 0);
    expect(zeroIdx).toBeGreaterThanOrEqual(0);
    expect(moves.some((m) => m.velocity.x !== 0 || m.velocity.y !== 0)).toBe(true);

    const brain = new BedrockBrain({
      ...options,
      client: stubClient(JSON.stringify({ moveIndex: zeroIdx })),
    });
    const chosen = await brain.pickMove(summary, moves);
    expect(chosen.velocity.x !== 0 || chosen.velocity.y !== 0).toBe(true);
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

  it('rejects a dominated model pick in favor of the heuristic', async () => {
    const { summary, moves } = fixtures();
    const heuristic = await new HeuristicBrain('AI Pilot').pickMove(summary, moves);
    // Prefer a grass / reverse crawl if one exists; else the worst pathProgress.
    let badIdx = moves.findIndex(
      (m) => m.grassShortcut && m.index !== heuristic.index
    );
    if (badIdx < 0) {
      badIdx = moves.reduce(
        (worst, m, i) => (m.pathProgress < moves[worst]!.pathProgress ? i : worst),
        0
      );
    }
    expect(isDominatedByHeuristic(moves[badIdx]!, heuristic)).toBe(true);

    const brain = new BedrockBrain({
      ...options,
      fallbackSeed: 'AI Pilot',
      client: stubClient(JSON.stringify({ moveIndex: badIdx })),
    });
    const chosen = await brain.pickMove(summary, moves);
    expect(chosen).toBe(heuristic);
  });

  it('skips Bedrock while gear-limited (penalty / off-track recovery)', async () => {
    const { summary, moves } = fixtures();
    summary.gearLimited = true;
    let called = false;
    const brain = new BedrockBrain({
      ...options,
      fallbackSeed: 'AI Pilot',
      client: {
        send: () => {
          called = true;
          return Promise.reject(new Error('should not call Bedrock'));
        },
      },
    });
    const chosen = await brain.pickMove(summary, moves);
    expect(called).toBe(false);
    expect(moves).toContain(chosen);
  });

  it('falls back to heuristic when Bedrock exceeds the timeout', async () => {
    const { summary, moves } = fixtures();
    const heuristic = await new HeuristicBrain('AI Pilot').pickMove(summary, moves);
    const brain = new BedrockBrain({
      ...options,
      fallbackSeed: 'AI Pilot',
      timeoutMs: 30,
      client: hangingClient(500),
    });
    const chosen = await brain.pickMove(summary, moves);
    expect(chosen).toBe(heuristic);
  });
});
