/**
 * Move-selection brains.
 *
 * Every brain receives the annotated legal-move list and MUST return one of
 * those moves — illegal outputs are impossible by construction. The Bedrock
 * brain asks Claude Opus with the same decide packet Laya uses. A legal
 * choice id is driven as Opus answered it. On any failure it falls back to
 * the heuristic so a race is never stalled by the model.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import {
  AiDifficulty,
  DIFFICULTY_TUNING,
  DifficultyTuning,
  difficultyFromUnknown,
} from './difficulty';
import { BEDROCK_LAYA_SYSTEM, layaPromptText } from './bedrock-dataset';
import { parseMoveLabel } from './laya-scene';
import { adviseBoost } from './boost-advice';
import { applySceneChoice } from './scene-choice';
import type { AnnotatedMove, BoardSummary } from './tools';
import { FUEL_RESERVE, pilotIntent, shouldPitForFuel, shouldSaveFuel } from '../../shared/ws-types';

export interface MoveBrain {
  pickMove(summary: BoardSummary, moves: AnnotatedMove[]): Promise<AnnotatedMove>;
}

export type { AiDifficulty } from './difficulty';
export { AI_DIFFICULTIES, DIFFICULTY_NICK_SUFFIX, DIFFICULTY_TUNING } from './difficulty';

// ------------------------------------------------------------- heuristic

/** Per-pilot driving style so two bots on adjacent grid slots diverge. */
export interface PilotStyle {
  /** Display / seed label. */
  seed: string;
  /** Scales acceleration bonuses (higher = pushes gear harder). */
  aggression: number;
  /** Scales braking / overspeed penalties (higher = lifts earlier). */
  caution: number;
  /** Soft ±1 nudge on target gear. */
  gearBias: number;
  /** Deterministic salt for near-tie breakers / mistakes. */
  salt: number;
}

/** Stable style derived from nickname (or any seed string). */
export function styleFromSeed(seed: string): PilotStyle {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = (shift: number) => ((h >>> shift) & 255) / 255;
  return {
    seed,
    aggression: 0.7 + u(0) * 0.7,
    caution: 0.7 + u(8) * 0.7,
    gearBias: Math.floor(u(16) * 3) - 1,
    salt: (h >>> 0) % 997,
  };
}

export interface HeuristicBrainOptions {
  styleOrSeed?: PilotStyle | string;
  difficulty?: AiDifficulty;
}

/**
 * Track-aware racer with difficulty tuning:
 * - Follow the asphalt corridor via directed pathDistance / pathProgress
 * - Accelerate when clearAhead is long and under a soft target speed
 * - Brake when overspeed or the runway ahead is short
 * - Optional PilotStyle so multiple bots don't drive as clones
 * - Easy/medium may intentionally pick a near-best move (mistakes)
 */
export class HeuristicBrain implements MoveBrain {
  private readonly style: PilotStyle;
  private readonly tuning: DifficultyTuning;

  constructor(styleOrSeed?: PilotStyle | string | HeuristicBrainOptions, difficulty?: AiDifficulty) {
    // HeuristicBrainOptions is a plain bag; PilotStyle always has seed + salt.
    if (
      styleOrSeed &&
      typeof styleOrSeed === 'object' &&
      !('salt' in styleOrSeed && 'seed' in styleOrSeed)
    ) {
      const opts = styleOrSeed as HeuristicBrainOptions;
      this.style =
        typeof opts.styleOrSeed === 'string' || opts.styleOrSeed === undefined
          ? styleFromSeed(opts.styleOrSeed ?? 'default')
          : opts.styleOrSeed;
      this.tuning = DIFFICULTY_TUNING[difficultyFromUnknown(opts.difficulty)];
    } else if (typeof styleOrSeed === 'string' || styleOrSeed === undefined) {
      this.style = styleFromSeed(styleOrSeed ?? 'default');
      this.tuning = DIFFICULTY_TUNING[difficultyFromUnknown(difficulty)];
    } else {
      this.style = styleOrSeed;
      this.tuning = DIFFICULTY_TUNING[difficultyFromUnknown(difficulty)];
    }
  }

  /** Active difficulty preset (for move delay / logging). */
  get difficulty(): AiDifficulty {
    return this.tuning.id;
  }

  get moveDelayMs(): number {
    return this.tuning.moveDelayMs;
  }

  pickMove(summary: BoardSummary, moves: AnnotatedMove[]): Promise<AnnotatedMove> {
    const hasMotion = moves.some((m) => m.velocity.x !== 0 || m.velocity.y !== 0);
    const currentGear = summary.gear;
    const bestClear = moves.reduce((max, m) => Math.max(max, m.clearAhead), 0);
    const { aggression: styleAgg, caution: styleCau, gearBias: styleBias, salt } = this.style;
    const t = this.tuning;
    const aggression = styleAgg * t.aggression;
    const caution = styleCau * t.caution;
    const gearBias = styleBias + t.gearBias;
    const intent = pilotIntent(this.style.seed);
    const lapCells = summary.lapCells ?? 160;
    const gap = summary.scene?.state.gap;
    const attack = typeof gap === 'number' && gap <= 6;
    const saveFuel =
      summary.fuel !== undefined &&
      shouldSaveFuel(intent.fuelPlan, summary.fuel, summary.situation.cellsToGoal, lapCells);
    const pitBox = summary.pitBox;
    const hereDist = pitBox
      ? Math.max(Math.abs(summary.position.x - pitBox.x), Math.abs(summary.position.y - pitBox.y))
      : Number.POSITIVE_INFINITY;
    const forecast =
      summary.fuel !== undefined &&
      !!pitBox &&
      shouldPitForFuel(intent.fuelPlan, summary.fuel, summary.situation.cellsToGoal, lapCells, hereDist);

    const targetGear = Math.max(
      1,
      Math.min(
        t.maxGear,
        Math.floor(Math.sqrt(Math.max(1, bestClear * t.clearSqrtScale))) + gearBias
      )
    );

    const scored: Array<{ move: AnnotatedMove; score: number }> = [];

    for (const move of moves) {
      let score = 0;

      if (hasMotion && move.velocity.x === 0 && move.velocity.y === 0) {
        score -= 50_000;
      }

      if (move.grassShortcut) score -= 10_000;
      if (move.landingTile === 'grass' || move.landingTile === 'rumble') score -= 5_000;

      const pit = summary.pitBox;
      const reserve = summary.fuel !== undefined && summary.fuel <= FUEL_RESERVE;
      const through = (summary.driveThroughOwed ?? 0) > 0;
      const onPitTile = move.landingTile === 'pit' || move.landingTile === 'pitbox';
      const hereDist = pit
        ? Math.max(Math.abs(summary.position.x - pit.x), Math.abs(summary.position.y - pit.y))
        : Number.POSITIVE_INFINITY;
      const commitFuel =
        !!pit &&
        ((reserve && (summary.fuel! <= 12 || hereDist <= 22 || !!summary.onPit)) || forecast);
      const commitThrough = !!pit && through && !reserve && (hereDist <= 14 || !!summary.onPit);
      if (pit && (commitFuel || commitThrough)) {
        const dist = Math.max(Math.abs(move.landing.x - pit.x), Math.abs(move.landing.y - pit.y));
        score += (48 - dist) * (commitFuel ? 180 : 90);
        if (onPitTile) score += commitFuel ? 4_000 : 3_000;
        if (!Number.isFinite(move.pathDistance)) score += 10_000;
        if (commitFuel && move.landing.x === pit.x && move.landing.y === pit.y) {
          score += 100_000;
          if (move.gear === 0) score += 5_000;
        }
        if (commitThrough && move.landing.x === pit.x && move.landing.y === pit.y && move.gear === 0) {
          score -= 8_000;
        }
      }

      // Soft gear cap: discourage (don't hard-filter) moves above difficulty max.
      if (move.gear > t.maxGear) score -= 400 * (move.gear - t.maxGear);

      if (summary.goal === 'checkpoint' && move.entersCheckpoint) score += 2_000;
      if (summary.goal === 'finish' && move.crossesFinish) score += 2_000;

      score += move.pathProgress * t.pathWeight;
      if (!Number.isFinite(move.pathDistance)) {
        score -= 10_000;
      } else {
        score -= move.pathDistance * 3;
      }

      score -= move.distanceToGoal;

      if (move.overspeed) score -= 600 * caution;
      if (move.clearAhead === 0 && move.gear > 0) score -= 250 * caution;
      if (move.clearAhead <= 1 && move.gear >= 3) score -= 150 * caution;
      if (move.clearAhead <= 2 && move.gear >= 4) score -= 100 * caution;

      const delta = move.gear - currentGear;

      if (
        move.clearAhead >= t.clearToAccel &&
        move.gear < targetGear &&
        delta > 0 &&
        !move.overspeed &&
        !move.grassShortcut
      ) {
        score += (55 + delta * 25) * aggression;
      }
      if (currentGear === 0 && move.gear === 1 && move.pathProgress > 0) {
        score += 60;
      }

      if ((move.overspeed || move.clearAhead <= 2) && delta < 0) {
        score += (70 + Math.abs(delta) * 25) * caution;
      }
      if (move.clearAhead <= 3 && delta > 0) {
        score -= 80 * delta * caution;
      }
      if (move.gear >= 3 && move.clearAhead < move.gear) {
        score -= 45 * (move.gear - move.clearAhead) * caution;
      }

      if (move.pathProgress < 0) score -= 100;

      if (move.clearAhead >= 5 && !move.overspeed && !commitFuel) {
        score += move.gear * 4 * aggression;
      }
      if ((move.drs || move.ers) && move.gear > currentGear && !move.overspeed && !commitFuel && !commitThrough) {
        score += (80 + (move.gear - currentGear) * 30) * aggression;
      }
      if (move.gear > 6 && move.clearAhead >= move.gear && !move.overspeed) {
        score += 120 * aggression;
      }

      const hx = summary.situation.raceHeading.x;
      const hy = summary.situation.raceHeading.y;
      const side =
        hx * (move.landing.y - summary.position.y) - hy * (move.landing.x - summary.position.x);
      score += side * intent.side * 8;
      if (saveFuel && move.gear > 4 && !commitFuel) score -= 70 * (move.gear - 4);
      if (saveFuel && move.gear >= 2 && move.gear <= 4 && !move.overspeed) score += 24;
      if (attack && intent.lateBrake && move.gear >= currentGear && !move.overspeed && !commitFuel) {
        score += 18 * intent.push;
      }
      if (!intent.lateBrake && (summary.situation.cellsToCorner ?? 99) < 8 && move.gear < currentGear) {
        score += 16;
      }

      score += ((move.index * 31 + salt) % 11) * 0.05;

      scored.push({ move, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const best = this.pickWithMistakes(scored, salt);
    return Promise.resolve(best);
  }

  /** Easy/medium: sometimes take 2nd/3rd best clean move so the pilot feels beatable. */
  private pickWithMistakes(
    scored: Array<{ move: AnnotatedMove; score: number }>,
    salt: number
  ): AnnotatedMove {
    const t = this.tuning;
    const clean = scored.filter(
      (s) => !s.move.grassShortcut && (s.move.velocity.x !== 0 || s.move.velocity.y !== 0)
    );
    const pool = (clean.length > 0 ? clean : scored).slice(0, Math.max(1, t.topK));
    if (pool.length === 1 || t.mistakeChance <= 0) {
      return pool[0]!.move;
    }

    // Deterministic "RNG" from salt + best move so replays / twins stay stable
    // for a given nickname, but still diverge across pilots.
    const roll = ((salt * 17 + pool[0]!.move.index * 13) % 1000) / 1000;
    if (roll >= t.mistakeChance) {
      return pool[0]!.move;
    }
    // Intentionally skip the top pick so the mistake is visible.
    const alt = pool.slice(1);
    if (alt.length === 0) return pool[0]!.move;
    const pick = (salt + pool[0]!.move.index) % alt.length;
    return alt[pick]!.move;
  }
}

function needsPit(summary: BoardSummary): boolean {
  if (!summary.pitBox) return false;
  const reserve = summary.fuel !== undefined && summary.fuel <= FUEL_RESERVE;
  const through = (summary.driveThroughOwed ?? 0) > 0;
  if (!reserve && !through) return false;
  const dist = Math.max(
    Math.abs(summary.position.x - summary.pitBox.x),
    Math.abs(summary.position.y - summary.pitBox.y)
  );
  if (summary.onPit) return true;
  if (reserve && (summary.fuel! <= 12 || dist <= 22)) return true;
  return through && dist <= 14;
}

/** Open DRS or spend ERS only when the stretch pays for it. A +1 on the wing does not cost a bar. */
export function withBoost(
  summary: BoardSummary,
  moves: AnnotatedMove[],
  chosen: AnnotatedMove
): AnnotatedMove {
  if (summary.gearLimited) return stripBoost(chosen);
  if (chosen.landingTile === 'pit' || chosen.landingTile === 'pitbox') return stripBoost(chosen);
  const facts = boostFacts(summary, chosen);
  const pick = chosen.boostPick ?? adviseBoost(facts);
  if (pick === 'save') return plainMove(moves, chosen);

  const drsReady = facts.drsArmed && !facts.drsActive;
  const ersReady = facts.ersCharge >= 1;
  const wantDrs = (pick === 'drs' || pick === 'both') && drsReady;
  const wantErs = (pick === 'ers' || pick === 'both') && ersReady;
  if (!wantDrs && !wantErs) return stripBoost(chosen);

  const cap = chosen.boostCap ?? 8;
  const faster = moves
    .filter(
      (move) =>
        move.gear > chosen.gear &&
        move.gear <= cap &&
        (wantDrs ? !!move.drs : !move.drs) &&
        (wantErs ? !!move.ers : !move.ers) &&
        boostSafe(summary, move)
    )
    .sort((a, b) => b.gear - a.gear || b.clearAhead - a.clearAhead)[0];
  const base = faster ?? chosen;
  return {
    ...base,
    drs: wantDrs,
    ers: wantErs,
    boostPick: pick,
    boostCap: cap,
  };
}

function stripBoost(move: AnnotatedMove): AnnotatedMove {
  return { ...move, drs: false, ers: false };
}

function plainMove(moves: AnnotatedMove[], chosen: AnnotatedMove): AnnotatedMove {
  const same = moves.find(
    (move) =>
      move.velocity.x === chosen.velocity.x &&
      move.velocity.y === chosen.velocity.y &&
      !move.drs &&
      !move.ers
  );
  if (same) return stripBoost(same);
  const fallback = moves
    .filter((move) => !move.drs && !move.ers && !move.grassShortcut && move.landingTile !== 'grass')
    .sort(
      (a, b) =>
        Math.abs(a.gear - chosen.gear) - Math.abs(b.gear - chosen.gear) || b.clearAhead - a.clearAhead
    )[0];
  return stripBoost(fallback ?? chosen);
}

function boostFacts(summary: BoardSummary, chosen: AnnotatedMove) {
  const state = summary.scene?.state ?? {};
  const gap = state.gap === 'lead' || typeof state.gap === 'number' ? state.gap : 'lead';
  return {
    gear: summary.gear,
    nextGear: chosen.gear,
    clearAhead: chosen.clearAhead,
    overspeed:
      chosen.overspeed ||
      chosen.grassShortcut ||
      chosen.landingTile === 'grass' ||
      chosen.landingTile === 'rumble',
    gearLimited: summary.gearLimited,
    drsArmed: !!summary.drsArmed,
    drsActive: !!summary.drsActive,
    ersCharge: summary.ersCharge ?? 0,
    gap,
    blue: typeof state.blue === 'number' ? state.blue : 0,
    bendCells: summary.situation.cellsToCorner,
    fuel: summary.fuel,
    pit: chosen.landingTile === 'pit' || chosen.landingTile === 'pitbox',
  };
}

function boostSafe(summary: BoardSummary, move: AnnotatedMove): boolean {
  if (move.grassShortcut || move.overspeed) return false;
  if (move.landingTile !== 'track' && move.landingTile !== 'finish') return false;
  if (move.clearAhead < move.gear) return false;
  const bend = summary.situation.cellsToCorner;
  return bend == null || bend > (move.gear * (move.gear + 1)) / 2;
}

/**
 * Pit before the model line when the tank is on reserve or a drive-through
 * is due on this pass. Otherwise attach DRS/ERS to an accelerating step.
 */
export async function applyPilotPolicy(
  summary: BoardSummary,
  moves: AnnotatedMove[],
  chosen: AnnotatedMove
): Promise<AnnotatedMove> {
  const pit = summary.pitBox;
  if (pit && summary.fuel !== undefined && summary.fuel <= FUEL_RESERVE) {
    const stall = moves.filter((move) => move.landing.x === pit.x && move.landing.y === pit.y);
    if (stall.length > 0) {
      stall.sort((a, b) => a.gear - b.gear);
      return stall[0]!;
    }
  }
  if (
    pit &&
    (summary.driveThroughOwed ?? 0) > 0 &&
    !(summary.fuel !== undefined && summary.fuel <= FUEL_RESERVE) &&
    needsPit(summary)
  ) {
    const lane = moves.filter(
      (move) =>
        (move.landingTile === 'pit' || move.landingTile === 'pitbox') &&
        (move.velocity.x !== 0 || move.velocity.y !== 0) &&
        !(move.landing.x === pit.x && move.landing.y === pit.y)
    );
    if (lane.length > 0) {
      lane.sort(
        (a, b) =>
          Math.max(Math.abs(a.landing.x - pit.x), Math.abs(a.landing.y - pit.y)) -
          Math.max(Math.abs(b.landing.x - pit.x), Math.abs(b.landing.y - pit.y))
      );
      return lane[0]!;
    }
  }
  if (needsPit(summary)) {
    const planned = await new HeuristicBrain({ styleOrSeed: 'pit', difficulty: 'pro' }).pickMove(
      summary,
      moves
    );
    return planned;
  }
  return withBoost(summary, moves, chosen);
}

// --------------------------------------------------------------- bedrock


/** Narrow client surface so tests can stub Bedrock without the real SDK. */
export interface ConverseClient {
  send(command: ConverseCommand): Promise<{
    output?: { message?: { content?: { text?: string }[] } };
  }>;
}

export interface BedrockBrainOptions {
  modelId: string;
  region: string;
  /** Injectable for tests. */
  client?: ConverseClient;
  /** Fallback when the model fails; defaults to HeuristicBrain. */
  fallback?: MoveBrain;
  maxTokens?: number;
  /** Seed for the heuristic fallback so each pilot stays distinct. */
  fallbackSeed?: string;
  /** Max wait for Converse before falling back (ms). */
  timeoutMs?: number;
  /** Difficulty applied to the heuristic fallback / quality floor. */
  difficulty?: AiDifficulty;
}

/**
 * True when the model pick is a catastrophic miss vs the heuristic floor.
 * Only veto grass-when-clean and driving the wrong way — overspeed / slightly
 * lower gear are legal racing choices and must not dump every IA turn.
 */
export function isDominatedByHeuristic(
  model: AnnotatedMove,
  heuristic: AnnotatedMove
): boolean {
  if (model.index === heuristic.index) return false;

  if (model.grassShortcut && !heuristic.grassShortcut) return true;
  if (model.pathProgress < 0 && heuristic.pathProgress > 0) return true;
  // Huge regression on the racing line (wrong corridor / u-turn).
  if (model.pathProgress < heuristic.pathProgress - 1) return true;

  return false;
}

export class BedrockBrain implements MoveBrain {
  private readonly client: ConverseClient;
  private readonly fallback: MoveBrain;
  private readonly modelId: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  readonly difficulty: AiDifficulty;

  constructor(options: BedrockBrainOptions) {
    this.modelId = options.modelId;
    this.difficulty = difficultyFromUnknown(options.difficulty);
    this.client =
      options.client ?? new BedrockRuntimeClient({ region: options.region });
    this.fallback =
      options.fallback ??
      new HeuristicBrain({
        styleOrSeed: options.fallbackSeed ?? 'bedrock-fallback',
        difficulty: this.difficulty,
      });
    this.maxTokens = options.maxTokens ?? 128;
    // Opus 4.7 is slower than Nova Micro. Stay under the host's 28s turn wait.
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  get moveDelayMs(): number {
    return DIFFICULTY_TUNING[this.difficulty].moveDelayMs;
  }

  async pickMove(summary: BoardSummary, moves: AnnotatedMove[]): Promise<AnnotatedMove> {
    if (moves.length === 1) return moves[0];

    // Always know the safe pick first — recovery path when Opus fails.
    const heuristicPick = await this.fallback.pickMove(summary, moves);

    const scene = summary.scene;
    if (!scene) return heuristicPick;

    try {
      const command = new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: BEDROCK_LAYA_SYSTEM }],
        messages: [
          {
            role: 'user',
            content: [{ text: layaPromptText(scene) }],
          },
        ],
        // Opus 4.7 rejects temperature, topP, and topK.
        inferenceConfig: { maxTokens: this.maxTokens },
      });

      const response = await this.sendWithTimeout(command);
      const text = (response.output?.message?.content ?? [])
        .map((block) => block.text ?? '')
        .filter((part) => part.length > 0)
        .join('\n');
      const choice = this.parseChoice(text, scene, moves);
      return applySceneChoice('Bedrock', scene, moves, choice, heuristicPick, { honorChoice: true });
    } catch (err) {
      console.warn('[BRAIN] Bedrock call failed — using heuristic:', err instanceof Error ? err.message : err);
    }
    return heuristicPick;
  }

  private sendWithTimeout(command: ConverseCommand) {
    return new Promise<Awaited<ReturnType<ConverseClient['send']>>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Bedrock timeout after ${this.timeoutMs}ms`)),
        this.timeoutMs
      );
      this.client
        .send(command)
        .then((res) => {
          clearTimeout(timer);
          resolve(res);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /**
   * Opus should answer with a bare choice id (`d0_p1`). It may still wrap
   * that id in JSON, or answer with the old moveIndex.
   */
  private parseChoice(text: string, scene: BoardSummary['scene'], moves: AnnotatedMove[]): string | null {
    const trimmed = text.trim();
    if (parseMoveLabel(trimmed)) return trimmed;
    const match = text.match(/\{[^{}]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]) as {
        choice?: unknown;
        move?: unknown;
        moveIndex?: unknown;
      };
      if (typeof parsed.choice === 'string' && parseMoveLabel(parsed.choice)) return parsed.choice;
      if (typeof parsed.move === 'string' && parseMoveLabel(parsed.move)) return parsed.move;
      if (typeof parsed.moveIndex === 'number' && Number.isInteger(parsed.moveIndex)) {
        const move = moves[parsed.moveIndex];
        if (!move) return null;
        const option = scene.options.find(
          (item) => item.velocity.x === move.velocity.x && item.velocity.y === move.velocity.y
        );
        return option?.label ?? null;
      }
      return null;
    } catch {
      return null;
    }
  }
}
