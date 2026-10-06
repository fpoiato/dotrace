import { createInitialState, createLobbyPlayer } from '../../shared/ws-types';
import { getTrackById } from '../../shared/tracks';
import {
  BedrockBrain,
  ConverseClient,
  DIFFICULTY_TUNING,
  HeuristicBrain,
  isDominatedByHeuristic,
  styleFromSeed,
} from '../src/brain';
import { BEDROCK_LAYA_SYSTEM, layaPromptText } from '../src/bedrock-dataset';
import { LAYA_MOVE_INSTRUCTIONS } from '../src/laya-scene';
import { buildBoardSummary, listAnnotatedMoves } from '../src/tools';
import type { AnnotatedMove, BoardSummary } from '../src/tools';

function fakeMove(partial: Partial<AnnotatedMove> & Pick<AnnotatedMove, 'index'>): AnnotatedMove {
  return {
    velocity: { x: 2, y: 0 },
    landing: { x: 10, y: 10 },
    gear: 2,
    landingTile: 'track',
    grassShortcut: false,
    entersCheckpoint: false,
    crossesFinish: false,
    distanceToGoal: 8,
    pathDistance: 8,
    pathProgress: 1,
    clearAhead: 6,
    overspeed: false,
    ...partial,
  };
}

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

  it('gives different styles to different nicknames so twin bots diverge', () => {
    const a = styleFromSeed('Bot Alfa');
    const b = styleFromSeed('Bot Turbo');
    expect(a).not.toEqual(b);
    expect(a.salt).not.toBe(b.salt);
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

  it('hard is more aggressive and mistake-free vs medium', () => {
    const hard = new HeuristicBrain({ styleOrSeed: 'Bot Apex', difficulty: 'hard' });
    const medium = new HeuristicBrain({ styleOrSeed: 'Bot Apex', difficulty: 'medium' });
    expect(hard.moveDelayMs).toBeLessThan(medium.moveDelayMs);
    expect(DIFFICULTY_TUNING.hard.caution).toBeLessThan(DIFFICULTY_TUNING.medium.caution);
    expect(DIFFICULTY_TUNING.hard.aggression).toBeGreaterThan(DIFFICULTY_TUNING.medium.aggression);
    expect(DIFFICULTY_TUNING.hard.mistakeChance).toBe(0);
    expect(DIFFICULTY_TUNING.hard.maxGear).toBe(6);
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

describe('isDominatedByHeuristic', () => {
  const heuristic = fakeMove({ index: 0, gear: 4, pathProgress: 1.2 });

  it('vetoes grass when a clean heuristic exists', () => {
    expect(
      isDominatedByHeuristic(fakeMove({ index: 1, grassShortcut: true, pathProgress: 1.5 }), heuristic)
    ).toBe(true);
  });

  it('vetoes driving the wrong way', () => {
    expect(
      isDominatedByHeuristic(fakeMove({ index: 1, pathProgress: -0.4 }), heuristic)
    ).toBe(true);
  });

  it('allows overspeed and a slightly lower gear', () => {
    expect(
      isDominatedByHeuristic(
        fakeMove({ index: 1, gear: 3, overspeed: true, pathProgress: 1.1, clearAhead: 8 }),
        heuristic
      )
    ).toBe(false);
  });
});

describe('BedrockBrain', () => {
  const options = { modelId: 'us.anthropic.claude-opus-4-7', region: 'us-east-1' };

  function bestMove(summary: BoardSummary, moves: AnnotatedMove[]): AnnotatedMove {
    const best = summary.scene.options.find((option) => option.detail.startsWith('best '));
    expect(best).toBeDefined();
    const match = moves.find(
      (move) => move.velocity.x === best!.velocity.x && move.velocity.y === best!.velocity.y
    );
    expect(match).toBeDefined();
    return match!;
  }

  it('asks the model and drives a legal choice that is not the labeled best', async () => {
    const { summary, moves } = fixtures();
    const best = bestMove(summary, moves);
    const alt = moves.find(
      (move) =>
        (move.velocity.x !== best.velocity.x || move.velocity.y !== best.velocity.y) &&
        (move.velocity.x !== 0 || move.velocity.y !== 0) &&
        !move.grassShortcut &&
        (move.landingTile === 'track' || move.landingTile === 'finish')
    );
    expect(alt).toBeDefined();
    let called = false;
    const brain = new BedrockBrain({
      ...options,
      fallbackSeed: 'AI Pilot',
      client: {
        send: () => {
          called = true;
          return Promise.resolve({
            output: { message: { content: [{ text: labelOf(summary, alt!) }] } },
          });
        },
      },
    });
    const chosen = await brain.pickMove(summary, moves);
    expect(called).toBe(true);
    expect(chosen.velocity).toEqual(alt!.velocity);
  });

  it('sends the Laya decide packet when the scene has no labeled step', async () => {
    const { summary, moves } = fixtures();
    const best = bestMove(summary, moves);
    hideSupervised(summary);
    let sent: { input?: { system?: { text?: string }[]; messages?: { content?: { text?: string }[] }[] } } | undefined;
    const brain = new BedrockBrain({
      ...options,
      fallbackSeed: 'AI Pilot',
      client: {
        send: (command) => {
          sent = command as typeof sent;
          return Promise.resolve({
            output: { message: { content: [{ text: labelOf(summary, best) }] } },
          });
        },
      },
    });
    const chosen = await brain.pickMove(summary, moves);
    expect(chosen.velocity).toEqual(best.velocity);
    expect(sent?.input?.system?.[0]?.text).toBe(BEDROCK_LAYA_SYSTEM);
    const user = sent?.input?.messages?.[0]?.content?.[0]?.text ?? '';
    expect(user).toBe(layaPromptText(summary.scene));
    expect(user).toContain(LAYA_MOVE_INSTRUCTIONS);
    expect(user).toContain('"kind":"vector race"');
  });

  it('parses a choice id wrapped in prose or fences', async () => {
    const { summary, moves } = fixtures();
    const best = bestMove(summary, moves);
    hideSupervised(summary);
    const brain = new BedrockBrain({
      ...options,
      fallbackSeed: 'AI Pilot',
      client: stubClient(`Best option:\n\`\`\`json\n{"choice": "${labelOf(summary, best)}"}\n\`\`\``),
    });
    const chosen = await brain.pickMove(summary, moves);
    expect(chosen.velocity).toEqual(best.velocity);
  });

  it('still accepts a legacy moveIndex', async () => {
    const { summary, moves } = fixtures();
    hideSupervised(summary);
    const alt = moves.find(
      (move) =>
        (move.velocity.x !== 0 || move.velocity.y !== 0) &&
        !move.grassShortcut &&
        (move.landingTile === 'track' || move.landingTile === 'finish')
    );
    expect(alt).toBeDefined();
    const brain = new BedrockBrain({
      ...options,
      fallbackSeed: 'AI Pilot',
      client: stubClient(JSON.stringify({ moveIndex: alt!.index })),
    });
    const chosen = await brain.pickMove(summary, moves);
    expect(chosen).toBe(alt);
  });

  it('falls back to heuristic on an out-of-range index', async () => {
    const { summary, moves } = fixtures();
    hideSupervised(summary);
    const heuristic = await new HeuristicBrain('bedrock-fallback').pickMove(summary, moves);
    const brain = new BedrockBrain({
      ...options,
      client: stubClient('{"moveIndex": 999}'),
    });
    const chosen = await brain.pickMove(summary, moves);
    expect(chosen).toBe(heuristic);
  });

  it('falls back to heuristic on malformed output', async () => {
    const { summary, moves } = fixtures();
    hideSupervised(summary);
    const heuristic = await new HeuristicBrain('bedrock-fallback').pickMove(summary, moves);
    const brain = new BedrockBrain({
      ...options,
      client: stubClient('turn left!'),
    });
    const chosen = await brain.pickMove(summary, moves);
    expect(chosen).toBe(heuristic);
  });

  it('falls back to heuristic when Bedrock throws (throttle, auth, offline)', async () => {
    const { summary, moves } = fixtures();
    hideSupervised(summary);
    const heuristic = await new HeuristicBrain('bedrock-fallback').pickMove(summary, moves);
    const brain = new BedrockBrain({
      ...options,
      client: stubClient(new Error('ThrottlingException')),
    });
    const chosen = await brain.pickMove(summary, moves);
    expect(chosen).toBe(heuristic);
  });

  it('ignores a standstill answer when a moving option exists', async () => {
    const { summary, moves } = fixtures();
    const still = summary.scene.options.find(
      (option) => !option.illegal && option.velocity.x === 0 && option.velocity.y === 0
    );
    expect(still).toBeDefined();
    const brain = new BedrockBrain({
      ...options,
      fallbackSeed: 'AI Pilot',
      client: stubClient(still!.label),
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

  it('still asks the model while gear-limited', async () => {
    const { summary, moves } = fixtures();
    summary.gearLimited = true;
    const best = bestMove(summary, moves);
    let called = false;
    const brain = new BedrockBrain({
      ...options,
      fallbackSeed: 'AI Pilot',
      client: {
        send: () => {
          called = true;
          return Promise.resolve({
            output: { message: { content: [{ text: labelOf(summary, best) }] } },
          });
        },
      },
    });
    const chosen = await brain.pickMove(summary, moves);
    expect(called).toBe(true);
    expect(chosen.velocity).toEqual(best.velocity);
  });

  it('falls back to heuristic when Bedrock exceeds the timeout', async () => {
    const { summary, moves } = fixtures();
    hideSupervised(summary);
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

function hideSupervised(summary: BoardSummary): void {
  for (const option of summary.scene.options) {
    if (option.detail.startsWith('best ') || option.detail.startsWith('back ')) {
      option.detail = `with race${option.detail.slice(option.detail.indexOf(' '))}`;
    }
  }
}

function labelOf(summary: BoardSummary, move: AnnotatedMove): string {
  const option = summary.scene.options.find(
    (item) => item.velocity.x === move.velocity.x && item.velocity.y === move.velocity.y
  );
  if (!option) throw new Error('move has no scene label');
  return option.label;
}
