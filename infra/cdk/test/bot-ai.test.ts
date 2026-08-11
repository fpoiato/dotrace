/**
 * Tests for the CPU racer planner (shared/bot-ai.ts).
 *
 * The planner runs in the host's browser but decides every CPU move, so it is
 * covered here in CI alongside the shared game rules. Most tests drive a full
 * race through the same move resolution the host applies, which is the only
 * honest way to tell whether a bot can actually get round a circuit.
 */
import {
  BotSkill,
  GameState,
  Player,
  TrackDefinition,
  Vector2D,
  applyGrassPenalty,
  createBotPlayer,
  createLobbyPlayer,
  gearOf,
  getTileAt,
  getValidMoves,
  isGrassShortcut,
  landingPosition,
  segmentCrossesFinish,
  segmentEntersRect,
  zeroVector,
} from '../../../shared/ws-types';
import { TRACKS, getTrackById } from '../../../shared/tracks';
import {
  botProfile,
  botThinkMs,
  botTurnDelayMs,
  lapProgress,
  planBotMove,
  remainingFor,
  trackGuide,
} from '../../../shared/bot-ai';

/** Deterministic RNG so bot "mistakes" are reproducible across runs. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeState(track: TrackDefinition, players: Player[], totalLaps = 1): GameState {
  return {
    phase: 'GAME_ROUND',
    players,
    hostId: 'host',
    trackId: track.id,
    turnOrder: players.map((p) => p.connectionId),
    currentTurnIndex: 0,
    round: 1,
    totalLaps,
    gameMode: 'TURNS',
    diceRolls: {},
    podium: [],
    replayLog: [],
  };
}

function placeOnGrid(track: TrackDefinition, player: Player, slot = 0): void {
  const start = track.startLine[slot % track.startLine.length];
  player.position = { ...start };
  player.velocity = zeroVector();
  player.isOffTrack = false;
  player.passedCheckpoint = false;
  player.trail = [{ ...start }];
  player.lap = 1;
}

/**
 * Mirror of the host's move resolution (GameEngineService.applyMove), trimmed
 * to what the planner can be judged on: position, gravel, grass penalties,
 * the checkpoint gate and lap counting.
 */
function resolveMove(
  state: GameState,
  track: TrackDefinition,
  player: Player,
  vector: Vector2D
): void {
  const from = { ...player.position };
  const landing = landingPosition(player.position, vector);
  const tile = getTileAt(track, landing.x, landing.y);
  const grassShortcut = isGrassShortcut(track, from, landing);

  player.position = landing;
  if (tile === 'grass' || tile === 'rumble') {
    player.velocity = zeroVector();
    player.isOffTrack = true;
  } else {
    player.velocity = { ...vector };
    player.isOffTrack = false;
  }
  if (grassShortcut) applyGrassPenalty(player, state);

  if (track.checkpoint && !player.passedCheckpoint) {
    player.passedCheckpoint = segmentEntersRect(from, landing, track.checkpoint);
  }

  const crossedFinish =
    player.passedCheckpoint !== false && segmentCrossesFinish(track, from, landing);
  if (crossedFinish && tile !== 'grass' && tile !== 'rumble') {
    if (player.lap < state.totalLaps) {
      player.lap += 1;
      player.passedCheckpoint = false;
    } else {
      player.finishOrder = 1;
    }
  }
}

interface RaceOutcome {
  finished: boolean;
  turns: number;
  grassCuts: number;
  offTrackTurns: number;
  /** Every chosen move was one the host would have accepted. */
  allMovesLegal: boolean;
  maxGear: number;
}

function raceSolo(
  track: TrackDefinition,
  skill: BotSkill,
  options: { totalLaps?: number; maxTurns?: number; seed?: number } = {}
): RaceOutcome {
  const { totalLaps = 1, maxTurns = 400, seed = 1 } = options;
  const random = seededRandom(seed);
  const bot = createBotPlayer('CPU', 0, '#fff', skill, 'solo');
  const state = makeState(track, [bot], totalLaps);
  placeOnGrid(track, bot);

  const outcome: RaceOutcome = {
    finished: false,
    turns: 0,
    grassCuts: 0,
    offTrackTurns: 0,
    allMovesLegal: true,
    maxGear: 0,
  };

  while (outcome.turns < maxTurns && bot.finishOrder === undefined) {
    const vector = planBotMove(
      { bot, track, players: state.players, round: state.round },
      random
    );
    expect(vector).not.toBeNull();
    const legal = getValidMoves(bot, track, state.players, state.round);
    if (!legal.some((m) => m.velocity.x === vector!.x && m.velocity.y === vector!.y)) {
      outcome.allMovesLegal = false;
      break;
    }
    outcome.maxGear = Math.max(outcome.maxGear, gearOf(vector!));
    resolveMove(state, track, bot, vector!);
    if (bot.isOffTrack) outcome.offTrackTurns += 1;
    outcome.turns += 1;
    state.round += 1;
  }

  outcome.finished = bot.finishOrder !== undefined;
  outcome.grassCuts = bot.grassCuts ?? 0;
  return outcome;
}

describe('track guide', () => {
  it('measures a plausible lap length on every circuit', () => {
    for (const track of TRACKS) {
      const guide = trackGuide(track);
      expect(guide.lapLength).toBeGreaterThan(100);
      expect(guide.lapLength).toBeLessThan(track.width * track.height);
      expect(guide.path).toHaveLength(guide.lapLength);
    }
  });

  it('starts the lap just past the stripe, where the grid sits', () => {
    for (const track of TRACKS) {
      const guide = trackGuide(track);
      const start = track.startLine[0];
      // The grid is a couple of cells beyond the line, so a car on pole has
      // essentially the whole lap in front of it.
      expect(lapProgress(guide, start, zeroVector())).toBeLessThan(
        guide.lapLength * 0.1
      );
      expect(getTileAt(track, guide.path[0].x, guide.path[0].y)).not.toBe('finish');
    }
  });

  it('runs the lap the way the direction flags point', () => {
    for (const track of TRACKS) {
      const guide = trackGuide(track);
      const dir = track.arrows[0].dir;
      const heading = {
        x: guide.path[1].x - guide.path[0].x,
        y: guide.path[1].y - guide.path[0].y,
      };
      expect(heading.x * dir.x + heading.y * dir.y).toBeGreaterThan(0);
    }
  });

  it('puts the lap checkpoint somewhere in the middle of the lap', () => {
    for (const track of TRACKS) {
      const guide = trackGuide(track);
      expect(guide.checkpointArc).toBeGreaterThan(guide.lapLength * 0.2);
      expect(guide.checkpointArc).toBeLessThan(guide.lapLength);
    }
  });

  it('reads a moving car\u2019s progress correctly all the way round', () => {
    for (const track of TRACKS) {
      const guide = trackGuide(track);
      for (let i = 0; i < guide.lapLength; i++) {
        // Probe with the displacement over a few cells, which is what a racing
        // car's velocity actually looks like.
        const back = guide.path[(i - 3 + guide.lapLength) % guide.lapLength];
        const velocity = { x: guide.path[i].x - back.x, y: guide.path[i].y - back.y };
        // Tight hairpins can double back over a cell they already used, which
        // reads a couple of cells early; anything more would be a wrong turn.
        expect(Math.abs(lapProgress(guide, guide.path[i], velocity) - i)).toBeLessThanOrEqual(3);
      }
    }
  });

  it('tells the two passes over a crossover apart', () => {
    // Suzuka is the only circuit that crosses itself, so it is the only one
    // whose cells should carry two lap positions.
    const doubleLabelled = (track: TrackDefinition): number => {
      const guide = trackGuide(track);
      let count = 0;
      for (let i = 0; i < guide.arcB.length; i++) {
        if (guide.arcB[i] >= 0) count += 1;
      }
      return count;
    };

    const suzuka = getTrackById('suzuka')!;
    expect(doubleLabelled(suzuka)).toBeGreaterThan(50);
    for (const simple of TRACKS.filter((t) => t.id !== 'suzuka')) {
      expect(doubleLabelled(simple)).toBeLessThan(30);
    }
  });

  it('reads the Suzuka crossover as two places a lap apart', () => {
    const guide = trackGuide(getTrackById('suzuka')!);
    // The centerline runs over one cell twice: once climbing into the upper
    // loop and once dropping back into the lower one.
    const shared = guide.path.findIndex(
      (p, i) => guide.path.some((q, j) => j > i + 50 && q.x === p.x && q.y === p.y)
    );
    expect(shared).toBeGreaterThanOrEqual(0);
    const cell = guide.path[shared];
    const twin = guide.path.findIndex(
      (q, j) => j > shared + 50 && q.x === cell.x && q.y === cell.y
    );

    const along = (i: number): Vector2D => {
      const back = guide.path[(i - 3 + guide.lapLength) % guide.lapLength];
      return { x: guide.path[i].x - back.x, y: guide.path[i].y - back.y };
    };
    expect(lapProgress(guide, cell, along(shared))).toBe(shared);
    expect(lapProgress(guide, cell, along(twin))).toBe(twin);
  });

  it('charges a whole extra lap for running past the checkpoint without it', () => {
    const guide = trackGuide(getTrackById('monza')!);
    const late = guide.path[guide.checkpointArc + 5];
    const velocity = {
      x: guide.path[guide.checkpointArc + 6].x - late.x,
      y: guide.path[guide.checkpointArc + 6].y - late.y,
    };
    const collected = remainingFor(guide, late, velocity, true);
    const missed = remainingFor(guide, late, velocity, false);
    expect(missed).toBe(collected + guide.lapLength);
  });

  it('caches one guide per track object', () => {
    expect(trackGuide(TRACKS[0])).toBe(trackGuide(TRACKS[0]));
  });
});

describe('planner move legality', () => {
  it('only ever returns a move the host would accept', () => {
    for (const track of TRACKS) {
      const outcome = raceSolo(track, 'MEDIUM', { maxTurns: 120 });
      expect(outcome.allMovesLegal).toBe(true);
    }
  });

  it('takes the emergency stop when boxed in at speed', () => {
    // 3x3 island of track: at gear 3 every ±1 continuation leaves the grid,
    // so getValidMoves offers only the emergency stop.
    const grid = Array.from({ length: 3 }, () =>
      Array.from({ length: 3 }, () => 'track' as const)
    ) as TrackDefinition['grid'];
    const track: TrackDefinition = {
      id: 'boxed',
      nameKey: 'tracks.test',
      width: 3,
      height: 3,
      grid,
      startLine: [{ x: 1, y: 1 }],
      centerline: [
        { x: 0, y: 1 },
        { x: 2, y: 1 },
        { x: 0, y: 1 },
      ],
      arrows: [],
    };
    const bot = createBotPlayer('CPU', 0, '#fff', 'HARD', 'boxed');
    bot.position = { x: 1, y: 1 };
    bot.velocity = { x: 0, y: 3 };
    const state = makeState(track, [bot]);
    expect(planBotMove({ bot, track, players: state.players, round: 1 })).toEqual({
      x: 0,
      y: 0,
    });
  });

  it('never lands on a square another car occupies', () => {
    const track = getTrackById('monza')!;
    const bot = createBotPlayer('CPU', 0, '#fff', 'HARD', 'a');
    const rival = createBotPlayer('Rival', 1, '#000', 'HARD', 'b');
    const state = makeState(track, [bot, rival]);
    placeOnGrid(track, bot, 0);

    const guide = trackGuide(track);
    const random = seededRandom(7);
    for (let turn = 0; turn < 60 && bot.finishOrder === undefined; turn++) {
      // Park the rival on the square the bot would most like to reach. Skip
      // the emergency stop, which by definition lands where the bot already is.
      const best = getValidMoves(bot, track, [bot], state.round)
        .filter((m) => m.landing.x !== bot.position.x || m.landing.y !== bot.position.y)
        .sort(
          (a, b) =>
            remainingFor(guide, a.landing, a.velocity, true) -
            remainingFor(guide, b.landing, b.velocity, true)
        )[0];
      if (!best) break;
      rival.position = { ...best.landing };

      const vector = planBotMove(
        { bot, track, players: state.players, round: state.round },
        random
      )!;
      const landing = landingPosition(bot.position, vector);
      expect(landing).not.toEqual(rival.position);
      resolveMove(state, track, bot, vector);
      state.round += 1;
    }
  });
});

describe('bots can actually drive', () => {
  it.each(TRACKS.map((t) => [t.id, t] as const))(
    'gets a hard bot round %s at racing speed',
    (_id, track) => {
      const outcome = raceSolo(track, 'HARD', { seed: 3 });
      expect(outcome.finished).toBe(true);
      // Never cuts a corner across the grass: that is the penalised, sloppy
      // mistake. Brushing a kerb into the last corner is fair racing.
      expect(outcome.grassCuts).toBe(0);
      expect(outcome.offTrackTurns).toBeLessThanOrEqual(1);
      expect(outcome.maxGear).toBe(botProfile('HARD').maxGear);
    }
  );

  it.each(TRACKS.map((t) => [t.id, t] as const))(
    'gets an easy bot round %s too, just slower',
    (_id, track) => {
      const outcome = raceSolo(track, 'EASY', { seed: 5 });
      expect(outcome.finished).toBe(true);
      expect(outcome.maxGear).toBeLessThanOrEqual(botProfile('EASY').maxGear);
    }
  );

  it('completes multi-lap races, re-arming the checkpoint each lap', () => {
    const outcome = raceSolo(getTrackById('monza')!, 'HARD', {
      totalLaps: 3,
      maxTurns: 600,
      seed: 11,
    });
    expect(outcome.finished).toBe(true);
  });

  it('makes harder bots quicker than easier ones on every circuit', () => {
    for (const track of TRACKS) {
      const hard = raceSolo(track, 'HARD', { seed: 3 });
      const medium = raceSolo(track, 'MEDIUM', { seed: 3 });
      const easy = raceSolo(track, 'EASY', { seed: 3 });
      // Medium can match hard on a circuit where gear 5 is enough everywhere,
      // but it must never beat it, and easy is always slower than both.
      expect(hard.turns).toBeLessThanOrEqual(medium.turns);
      expect(medium.turns).toBeLessThan(easy.turns);
    }
  });

  it('recovers when it starts stranded in the gravel', () => {
    const track = getTrackById('interlagos')!;
    const bot = createBotPlayer('CPU', 0, '#fff', 'HARD', 'stuck');
    const state = makeState(track, [bot]);
    placeOnGrid(track, bot);

    // Shove the bot sideways off the start straight into the grass.
    let landed = false;
    for (let dy = 1; dy <= 8 && !landed; dy++) {
      const probe = { x: bot.position.x, y: bot.position.y + dy };
      if (getTileAt(track, probe.x, probe.y) === 'grass') {
        bot.position = probe;
        bot.isOffTrack = true;
        bot.velocity = zeroVector();
        landed = true;
      }
    }
    expect(landed).toBe(true);

    const random = seededRandom(13);
    let recovered = false;
    for (let turn = 0; turn < 12 && !recovered; turn++) {
      const vector = planBotMove(
        { bot, track, players: state.players, round: state.round },
        random
      )!;
      resolveMove(state, track, bot, vector);
      state.round += 1;
      recovered = !bot.isOffTrack;
    }
    expect(recovered).toBe(true);
  });
});

describe('when the host should play a bot move', () => {
  const track = getTrackById('monza')!;

  function twoUp(gameMode: 'TURNS' | 'TIMED' = 'TURNS'): {
    state: GameState;
    human: Player;
    bot: Player;
  } {
    const human = createLobbyPlayer('human', 'Ana', true, 0, '#EF4444');
    const bot = createBotPlayer('Ayrton', 1, '#3B82F6', 'MEDIUM', 'a');
    const state = makeState(track, [human, bot]);
    state.gameMode = gameMode;
    return { state, human, bot };
  }

  it('waits for the bot to be on turn in a turn-based race', () => {
    const { state, bot } = twoUp();
    expect(botTurnDelayMs(state, bot)).toBeNull();
    state.currentTurnIndex = 1;
    expect(botTurnDelayMs(state, bot)).toBe(botThinkMs('MEDIUM'));
  });

  it('never plays a bot outside an active race', () => {
    const { state, bot } = twoUp();
    state.currentTurnIndex = 1;
    for (const phase of ['LOBBY', 'GRID_ORDER', 'GAME_OVER'] as const) {
      state.phase = phase;
      expect(botTurnDelayMs(state, bot)).toBeNull();
    }
  });

  it('never plays a bot that has already finished', () => {
    const { state, bot } = twoUp();
    state.currentTurnIndex = 1;
    bot.finishOrder = 1;
    expect(botTurnDelayMs(state, bot)).toBeNull();
  });

  it('lets every bot move whenever it likes in a timed race', () => {
    const { state, bot } = twoUp('TIMED');
    expect(state.currentTurnIndex).toBe(0);
    expect(botTurnDelayMs(state, bot)).toBe(botThinkMs('MEDIUM'));
  });

  it('sits out a timed stop penalty instead of giving up on the bot', () => {
    const { state, bot } = twoUp('TIMED');
    const now = 10_000;
    bot.stopUntil = now + 5_000;
    const wait = botTurnDelayMs(state, bot, now);
    expect(wait).not.toBeNull();
    expect(wait!).toBeGreaterThan(5_000);

    // Once it has run out, the bot goes back to its usual thinking pause.
    expect(botTurnDelayMs(state, bot, now + 6_000)).toBe(botThinkMs('MEDIUM'));
  });

  it('gives weaker bots a longer pause, so they read as slower to decide', () => {
    const { state, bot } = twoUp();
    state.currentTurnIndex = 1;
    bot.botSkill = 'EASY';
    const easy = botTurnDelayMs(state, bot)!;
    bot.botSkill = 'HARD';
    expect(botTurnDelayMs(state, bot)!).toBeLessThan(easy);
  });
});

describe('bot profiles', () => {
  it('gets deeper and faster as skill goes up', () => {
    const easy = botProfile('EASY');
    const medium = botProfile('MEDIUM');
    const hard = botProfile('HARD');
    expect(easy.depth).toBeLessThan(medium.depth);
    expect(medium.depth).toBeLessThan(hard.depth);
    expect(easy.maxGear).toBeLessThan(hard.maxGear);
    expect(easy.mistakeChance).toBeGreaterThan(hard.mistakeChance);
    expect(hard.thinkMs).toBeLessThan(easy.thinkMs);
  });

  it('falls back to the medium profile for an unset skill', () => {
    expect(botProfile(undefined)).toBe(botProfile('MEDIUM'));
  });
});
