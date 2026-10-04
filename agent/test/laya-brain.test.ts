import { createInitialState, createLobbyPlayer, segmentCrossesFinish } from '../../shared/ws-types';
import { getTrackById } from '../../shared/tracks';
import { HeuristicBrain } from '../src/brain';
import { LayaBrain } from '../src/laya-brain';
import {
  buildLayaScene,
  LAYA_DECIDE_MODEL,
  LAYA_REQUEST_CHAR_BUDGET,
  layaDecideBody,
  moveLabel,
  parseMoveLabel,
} from '../src/laya-scene';
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
  it('marks the car, the other pilot, and a 3-round hold', () => {
    const { me, state } = race();
    const scene = buildLayaScene(me, state, track);
    const grid = String(scene.state.grid);
    expect(grid).toContain('@');
    expect(grid).toContain('A');
    expect(scene.state.hold).toBe(
      'leaves grass on 1: 1 18,28 grass, 2 24,28 grass, 3 30,28 grass'
    );
    const rows = grid.split('\n');
    const row = rows.find((line) => line.includes('@'));
    expect(row?.startsWith('@')).toBe(true);
    expect(row).toContain('1');
    expect(row).toContain('2');
    expect(row).toContain('3');
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
    expect(faster?.detail).toBe('illegal gear');
    expect(scene.options.some((option) => option.detail.startsWith('back'))).toBe(false);
    expect(scene.options.some((option) => option.detail.startsWith('best '))).toBe(true);
  });

  it('fits the typed-decisions request budget, questions included', () => {
    const scenes = [buildLayaScene(race().me, race().state, track)];
    const monaco = getTrackById('monaco')!;
    const { me, state } = race();
    me.position = { x: 7, y: 46 };
    me.velocity = { x: 0, y: 0 };
    me.isOffTrack = true;
    scenes.push(buildLayaScene(me, state, monaco));

    const interlagos = getTrackById('interlagos')!;
    me.position = { x: 42, y: 6 };
    me.velocity = { x: 0, y: 0 };
    me.isOffTrack = false;
    scenes.push(buildLayaScene(me, state, interlagos));
    me.position = { x: 30, y: 8 };
    me.velocity = { x: -5, y: 0 };
    scenes.push(buildLayaScene(me, state, interlagos));
    me.position = { x: 20, y: 30 };
    me.velocity = { x: 6, y: -6 };
    scenes.push(buildLayaScene(me, state, track));

    for (const scene of scenes) {
      const text = JSON.stringify(layaDecideBody(scene, LAYA_DECIDE_MODEL));
      expect(text.length).toBeLessThan(LAYA_REQUEST_CHAR_BUDGET);
    }
  });

  it('tells an off-track car which step is closer to the asphalt', () => {
    const monaco = getTrackById('monaco')!;
    const { me, state } = race();
    me.position = { x: 7, y: 46 };
    me.velocity = { x: 0, y: 0 };
    me.isOffTrack = true;
    const scene = buildLayaScene(me, state, monaco);
    const toward = scene.options.find((option) => option.label === moveLabel(1, -1));
    const away = scene.options.find((option) => option.label === moveLabel(0, 1));
    const steps = (detail: string | undefined) =>
      Number(/(?:back|away) (\d+)/.exec(detail ?? '')?.[1]);
    expect(steps(toward?.detail)).toBeLessThan(steps(away?.detail));
    const back = scene.options.filter((option) => option.detail.startsWith('back '));
    expect(back).toHaveLength(1);
    expect(steps(back[0]?.detail)).toBeLessThanOrEqual(steps(toward?.detail));
    expect(back[0]?.detail).toMatch(/^back \d+ -?\d+,-?\d+$/);
  });

  it('names the circuit direction on the Interlagos grid', () => {
    const interlagos = getTrackById('interlagos')!;
    const { me, state } = race();
    me.position = { x: 42, y: 6 };
    me.velocity = { x: 0, y: 0 };
    const scene = buildLayaScene(me, state, interlagos);
    expect(scene.state.kind).toBe('vector race');
    expect(String(scene.state.dir).startsWith('-')).toBe(true);
    expect(scene.state.aim).toBe('stopped');
    expect(scene.state.bend).toEqual(expect.any(String));
    expect(scene.state.pace).toEqual(expect.any(Number));
    expect(scene.state.line).toEqual(expect.any(Number));
    expect(scene.state.stopDist).toBe(0);
    const best = scene.options.find((option) => option.detail.startsWith('best '));
    expect(best?.velocity.x).toBeLessThan(0);
    expect(best?.detail).toMatch(/^best( gate)? -?\d+,-?\d+ g\d+ r\d+$/);
    const right = scene.options.find((option) => option.label === moveLabel(1, 0));
    expect(right?.detail.startsWith('wrong way')).toBe(true);
    const body = layaDecideBody(scene, LAYA_DECIDE_MODEL);
    expect(body.model).toBe('laya:typed-decisions');
    expect(body.questions.move.instructions).toContain('Vector race');
    expect(body.questions.move.instructions).toContain('dir is the circuit direction');
    expect(body.questions.move.instructions).toContain('stopDist');
    expect(body.questions.move.instructions).toContain('Accelerate up to pace');
    expect(body.questions.move.instructions).toContain('penalty caps gear at 1');
    expect(body.questions.move.instructions).toContain('hold is the next 3 turns');
    expect(body.questions.move.instructions).toContain('Grid is only the road ahead');
    expect(body.questions.move.instructions).toContain('Nothing behind');
    const ahead = String(scene.state.grid).split('\n').find((line) => line.includes('@'));
    expect(ahead?.endsWith('@')).toBe(true);
  });

  it('calls the step back to the asphalt when the car is stuck off Interlagos', () => {
    const interlagos = getTrackById('interlagos')!;
    const { me, state } = race();
    me.position = { x: 51, y: 2 };
    me.velocity = { x: 0, y: 0 };
    me.isOffTrack = true;
    const scene = buildLayaScene(me, state, interlagos);
    const stopped = scene.options.find((option) => option.label === moveLabel(0, 0));
    const back = scene.options.find((option) => option.detail.startsWith('back '));
    const steps = (detail: string | undefined) =>
      Number(/(?:back|away) (\d+)/.exec(detail ?? '')?.[1]);
    expect(back).toBeDefined();
    expect(stopped?.detail.startsWith('back')).toBe(false);
    expect(steps(back?.detail)).toBeLessThan(steps(stopped?.detail));
    expect(stopped?.detail).toMatch(/^away \d+ 0,0$/);
  });

  it('turns into the Interlagos kink and keeps the gear', () => {
    const interlagos = getTrackById('interlagos')!;
    const { me, state } = race();
    me.position = { x: 30, y: 8 };
    me.velocity = { x: -5, y: 0 };
    const scene = buildLayaScene(me, state, interlagos);
    const best = scene.options.find((option) => option.detail.startsWith('best '));
    const held = scene.options.find((option) => option.label === moveLabel(0, 0));
    expect(scene.state.stopDist).toBe(15);
    expect(String(scene.state.bend)).not.toBe('straight');
    expect(best).toBeDefined();
    expect(best!.velocity.y).toBeGreaterThan(0);
    expect(Math.max(Math.abs(best!.velocity.x), Math.abs(best!.velocity.y))).toBe(5);
    expect(held?.detail.startsWith('best')).toBe(false);
    expect(held?.detail.startsWith('too fast') || held?.detail.startsWith('with race')).toBe(true);
    const ahead = String(scene.state.grid).split('\n').find((line) => line.includes('@'));
    expect(ahead?.endsWith('@')).toBe(true);
    expect(ahead).toContain('1');
    expect(ahead).toContain('2');
    expect(ahead).toContain('3');
  });

  it('carries speed on the Monza back straight and does not steer down before the right-hander', () => {
    const monza = getTrackById('monza')!;
    const straight = race();
    straight.me.position = { x: 56, y: 20 };
    straight.me.velocity = { x: -3, y: 0 };
    const open = buildLayaScene(straight.me, straight.state, monza);
    expect(open.state.bend).toBe('straight');
    expect(open.state.pace).toBe(6);
    const best = open.options.find((option) => option.detail.startsWith('best '));
    expect(best?.velocity.y).toBeLessThan(0);
    expect(Math.max(Math.abs(best!.velocity.x), Math.abs(best!.velocity.y))).toBeGreaterThanOrEqual(3);
    const held = open.options.find((option) => option.velocity.x === -3 && option.velocity.y === 0);
    expect(held?.detail.startsWith('drift')).toBe(true);

    const corner = race();
    corner.me.position = { x: 60, y: 45 };
    corner.me.velocity = { x: 4, y: 0 };
    const scene = buildLayaScene(corner.me, corner.state, monza);
    const brake = scene.options.find((option) => option.detail.startsWith('best '));
    expect(brake?.velocity.y).toBeLessThanOrEqual(0);
    expect(Math.max(Math.abs(brake!.velocity.x), Math.abs(brake!.velocity.y))).toBeGreaterThanOrEqual(4);
  });

  it('keeps speed down the Monza return straight', () => {
    const monza = getTrackById('monza')!;
    const { me, state } = race();
    me.position = { x: 7, y: 19 };
    me.velocity = { x: 1, y: 2 };
    me.passedCheckpoint = true;
    const scene = buildLayaScene(me, state, monza);
    expect(scene.state.bend).toBe('straight');
    expect(scene.state.pace).toBe(6);
    const best = scene.options.find((option) => option.detail.startsWith('best '));
    expect(best?.velocity.y).toBeGreaterThanOrEqual(2);
    expect(Math.max(Math.abs(best!.velocity.x), Math.abs(best!.velocity.y))).toBeGreaterThanOrEqual(3);
  });

  it('finishes a lap on Monza, Interlagos, and Monaco without leaving the asphalt', () => {
    const starts = [
      ['monza', 47, 50, 50],
      ['interlagos', 42, 6, 70],
      ['monaco', 42, 30, 55],
    ] as const;
    for (const [id, x, y, limit] of starts) {
      const circuit = getTrackById(id)!;
      const me = createLobbyPlayer('ai-1', 'Bot Alfa', false, 1, '#3B82F6');
      me.position = { x, y };
      me.velocity = { x: 0, y: 0 };
      const state = createInitialState([me], 'human');
      state.phase = 'GAME_ROUND';
      state.trackId = id;
      state.players = [me];
      let maxGear = 0;
      let finished = 0;
      for (let turn = 1; turn <= limit; turn++) {
        state.round = turn;
        const scene = buildLayaScene(me, state, circuit);
        const best = scene.options.find((option) => option.detail.startsWith('best '));
        expect(best).toBeDefined();
        maxGear = Math.max(maxGear, Math.max(Math.abs(best!.velocity.x), Math.abs(best!.velocity.y)));
        const from = { ...me.position };
        me.velocity = { ...best!.velocity };
        me.position = { ...best!.landing };
        const cp = circuit.checkpoint;
        if (
          cp &&
          me.position.x >= cp.x0 &&
          me.position.x <= cp.x1 &&
          me.position.y >= cp.y0 &&
          me.position.y <= cp.y1
        ) {
          me.passedCheckpoint = true;
        }
        if (me.passedCheckpoint && segmentCrossesFinish(circuit, from, me.position)) {
          finished = turn;
          break;
        }
      }
      expect(finished).toBeGreaterThan(0);
      expect(maxGear).toBe(6);
    }
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
    const legal = summary.scene.options.find((option) => option.detail.startsWith('best '));
    expect(legal).toBeDefined();
    const chosen = await brain({
      answers: { move: { choice: legal!.label } },
    }).pickMove(summary, moves);
    expect(chosen.velocity).toEqual(legal!.velocity);
  });

  it('asks laya:typed-decisions when no model is configured', async () => {
    const legal = summary.scene.options.find((option) => option.detail.startsWith('best '));
    expect(legal).toBeDefined();
    let posted = '';
    const fetchImpl = jest.fn(async (_url: unknown, init?: { body?: string }) => {
      posted = init?.body ?? '';
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ answers: { move: { choice: legal!.label } } }),
      };
    }) as unknown as typeof fetch;
    const local = new LayaBrain({
      endpoint: async () => ({ url: 'http://ollaya.test', apiKey: 'k' }),
      fetchImpl,
      fallback: new HeuristicBrain('Bot Alfa'),
      timeoutMs: 1000,
    });
    await local.pickMove(summary, moves);
    expect(JSON.parse(posted).model).toBe(LAYA_DECIDE_MODEL);
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

  it('shows that holding course on the Monza straight leaves the grass', () => {
    const monza = getTrackById('monza')!;
    const { me, state } = race();
    me.position = { x: 48, y: 47 };
    me.velocity = { x: 1, y: -2 };
    const scene = buildLayaScene(me, state, monza);
    expect(scene.state.hold).toBe(
      'leaves grass on 2: 1 49,45 asphalt, 2 50,43 grass, 3 51,41 grass'
    );
    const rows = String(scene.state.grid).split('\n');
    expect(rows[rows.length - 1]?.startsWith('@')).toBe(true);
    expect(scene.state.grid).toContain('1');
    expect(scene.state.grid).toContain('2');
    expect(scene.state.grid).toContain('3');
    const intoGrass = scene.options.find((option) => option.velocity.x === 1 && option.velocity.y === -3);
    expect(intoGrass?.detail).toBe('penalty gear 1');
  });

  it('falls back when Laya stands still and the car can move', async () => {
    const monza = getTrackById('monza')!;
    const { me, state } = race();
    me.position = { x: 47, y: 50 };
    me.velocity = { x: 0, y: 0 };
    const summary = buildBoardSummary(me, state, monza);
    const moves = listAnnotatedMoves(me, state, monza);
    const fallback = new HeuristicBrain({ styleOrSeed: 'Bot Alfa', difficulty: 'pro' });
    const heuristic = await fallback.pickMove(summary, moves);
    expect(heuristic.velocity).not.toEqual({ x: 0, y: 0 });
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ answers: { move: { choice: moveLabel(0, 0) } } }),
    })) as unknown as typeof fetch;
    const local = new LayaBrain({
      endpoint: async () => ({ url: 'http://ollaya.test', apiKey: 'k' }),
      fetchImpl,
      fallback,
      timeoutMs: 1000,
    });
    const chosen = await local.pickMove(summary, moves);
    const best = summary.scene.options.find((option) => option.detail.startsWith('best '));
    expect(best?.velocity).toEqual({ x: 1, y: 0 });
    expect(chosen.velocity).toEqual(best!.velocity);
  });

  it('uses best when Laya sheds gear on an open straight', async () => {
    const monza = getTrackById('monza')!;
    const { me, state } = race();
    me.position = { x: 50, y: 19 };
    me.velocity = { x: -3, y: -1 };
    const summary = buildBoardSummary(me, state, monza);
    const moves = listAnnotatedMoves(me, state, monza);
    const best = summary.scene.options.find((option) => option.detail.startsWith('best '));
    const slow = summary.scene.options.find(
      (option) => option.velocity.x === -3 && option.velocity.y === -1
    );
    expect(best).toBeDefined();
    expect(slow).toBeDefined();
    expect(Math.max(Math.abs(best!.velocity.x), Math.abs(best!.velocity.y))).toBeGreaterThan(3);
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ answers: { move: { choice: slow!.label } } }),
    })) as unknown as typeof fetch;
    const local = new LayaBrain({
      endpoint: async () => ({ url: 'http://ollaya.test', apiKey: 'k' }),
      fetchImpl,
      fallback: new HeuristicBrain('Bot Alfa'),
      timeoutMs: 1000,
    });
    const chosen = await local.pickMove(summary, moves);
    expect(chosen.velocity).toEqual(best!.velocity);
  });

  it('uses best when Laya drifts off the straight', async () => {
    const monza = getTrackById('monza')!;
    const { me, state } = race();
    me.position = { x: 56, y: 20 };
    me.velocity = { x: -3, y: 0 };
    const summary = buildBoardSummary(me, state, monza);
    const moves = listAnnotatedMoves(me, state, monza);
    const best = summary.scene.options.find((option) => option.detail.startsWith('best '));
    const drift = summary.scene.options.find((option) => option.detail.startsWith('drift '));
    expect(best).toBeDefined();
    expect(drift).toBeDefined();
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ answers: { move: { choice: drift!.label } } }),
    })) as unknown as typeof fetch;
    const local = new LayaBrain({
      endpoint: async () => ({ url: 'http://ollaya.test', apiKey: 'k' }),
      fetchImpl,
      fallback: new HeuristicBrain('Bot Alfa'),
      timeoutMs: 1000,
    });
    const chosen = await local.pickMove(summary, moves);
    expect(chosen.velocity).toEqual(best!.velocity);
  });

  it('falls back when Laya cuts the grass and an asphalt option exists', async () => {
    const fallback = new HeuristicBrain('Bot Alfa');
    const heuristic = await fallback.pickMove(summary, moves);
    const grass = summary.scene.options.find((option) => option.detail === 'penalty gear 1');
    expect(grass).toBeDefined();
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ answers: { move: { choice: grass!.label } } }),
    })) as unknown as typeof fetch;
    const local = new LayaBrain({
      endpoint: async () => ({ url: 'http://ollaya.test', apiKey: 'k' }),
      fetchImpl,
      fallback,
      timeoutMs: 1000,
    });
    const chosen = await local.pickMove(summary, moves);
    const best = summary.scene.options.find((option) => option.detail.startsWith('best '));
    expect(chosen.grassShortcut).toBe(false);
    expect(chosen.velocity).toEqual(best ? best.velocity : heuristic.velocity);
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
