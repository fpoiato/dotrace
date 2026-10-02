import { createInitialState, createLobbyPlayer } from '../../shared/ws-types';
import { getTrackById } from '../../shared/tracks';
import { HeuristicBrain } from '../src/brain';
import { LayaBrain } from '../src/laya-brain';
import { buildLayaScene, moveLabel, parseMoveLabel } from '../src/laya-scene';
import { buildBoardSummary, listAnnotatedMoves } from '../src/tools';

const track = getTrackById('monza')!;

function race() {
  const me = createLobbyPlayer('ai-1', 'Bot Alfa', false, 1, '#3B82F6');
  me.position = { x: 12, y: 28 };
  me.velocity = { x: 6, y: 0 };
  const other = createLobbyPlayer('human', 'Ada', true, 0, '#EF4444');
  other.position = { x: 14, y: 28 };
  other.velocity = { x: 1, y: 0 };
  const state = createInitialState([other, me], 'human');
  state.phase = 'GAME_ROUND';
  state.trackId = track.id;
  state.players = [other, me];
  state.round = 2;
  return { me, state };
}

describe('laya scene', () => {
  it('marks the car, the other pilot, and a 3-round coast', () => {
    const { me, state } = race();
    const scene = buildLayaScene(me, state, track);
    const grid = String(scene.state.grid);
    expect(grid).toContain('@');
    expect(grid).toContain('A');
    expect(scene.state.coast).toEqual([
      expect.objectContaining({ k: 1, x: 18, y: 28 }),
      expect.objectContaining({ k: 2, x: 24, y: 28 }),
      expect.objectContaining({ k: 3, x: 30, y: 28 }),
    ]);
  });

  it('offers all nine gear changes and marks gear 7 as illegal', () => {
    const { me, state } = race();
    const scene = buildLayaScene(me, state, track);
    expect(scene.options).toHaveLength(9);
    expect(new Set(scene.options.map((option) => option.label)).size).toBe(9);
    const faster = scene.options.find((option) => option.label === moveLabel(1, 0));
    expect(faster?.illegal).toBe(true);
    expect(faster?.detail).toContain('illegal');
    expect(parseMoveLabel(moveLabel(-1, 1))).toEqual({ dx: -1, dy: 1 });
    expect(parseMoveLabel('nope')).toBeNull();
  });
});

describe('LayaBrain', () => {
  const { me, state } = race();
  const summary = buildBoardSummary(me, state, track);
  const moves = listAnnotatedMoves(me, state, track);

  function brain(payload: unknown, status = 200) {
    const fetchImpl = jest.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => 'nope',
      json: async () => payload,
    })) as unknown as typeof fetch;
    return new LayaBrain({
      endpoint: async () => ({ url: 'http://ollaya.test', apiKey: 'k' }),
      fetchImpl,
      fallback: new HeuristicBrain('Bot Alfa'),
      timeoutMs: 1000,
    });
  }

  it('submits the velocity for the chosen legal label', async () => {
    const legal = moves.find((move) => move.velocity.x === 5 && move.velocity.y === 0);
    expect(legal).toBeDefined();
    const chosen = await brain({
      answers: { move: { choice: moveLabel(-1, 0) } },
    }).pickMove(summary, moves);
    expect(chosen.velocity).toEqual(legal!.velocity);
  });

  it('falls back when the label is illegal or the call fails', async () => {
    const heuristic = await new HeuristicBrain('Bot Alfa').pickMove(summary, moves);
    const illegal = await brain({
      answers: { move: { choice: moveLabel(1, 0) } },
    }).pickMove(summary, moves);
    expect(illegal).toBe(heuristic);

    const down = await brain({}, 503).pickMove(summary, moves);
    expect(down).toBe(heuristic);

    const truncated = await brain({
      state_truncated: true,
      answers: { move: { choice: moveLabel(-1, 0) } },
    }).pickMove(summary, moves);
    expect(truncated).toBe(heuristic);
  });

  it('falls back when no endpoint is published yet', async () => {
    const heuristic = await new HeuristicBrain('Bot Alfa').pickMove(summary, moves);
    const local = new LayaBrain({
      endpoint: async () => null,
      fetchImpl: jest.fn() as unknown as typeof fetch,
      fallback: new HeuristicBrain('Bot Alfa'),
    });
    expect(await local.pickMove(summary, moves)).toBe(heuristic);
  });
});
