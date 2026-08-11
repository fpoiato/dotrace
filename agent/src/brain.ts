/**
 * Move-selection brains.
 *
 * Every brain receives the annotated legal-move list and MUST return one of
 * those moves — illegal outputs are impossible by construction. The Bedrock
 * brain asks an LLM to pick; on any failure (throttle, bad JSON, out-of-range
 * index) it silently falls back to the deterministic heuristic so a race is
 * never stalled by the model.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type { AnnotatedMove, BoardSummary } from './tools';

export interface MoveBrain {
  pickMove(summary: BoardSummary, moves: AnnotatedMove[]): Promise<AnnotatedMove>;
}

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
  /** Deterministic salt for near-tie breakers. */
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

/**
 * Track-aware racer:
 * - Follow the asphalt corridor via directed pathDistance / pathProgress
 * - Accelerate when clearAhead is long and under a soft target speed
 * - Brake when overspeed or the runway ahead is short
 * - Never prefer grass shortcuts when a clean move exists
 * - Optional PilotStyle so multiple bots don't drive as clones
 */
export class HeuristicBrain implements MoveBrain {
  private readonly style: PilotStyle;

  constructor(styleOrSeed?: PilotStyle | string) {
    if (typeof styleOrSeed === 'string') {
      this.style = styleFromSeed(styleOrSeed);
    } else {
      this.style = styleOrSeed ?? styleFromSeed('default');
    }
  }

  pickMove(summary: BoardSummary, moves: AnnotatedMove[]): Promise<AnnotatedMove> {
    const hasMotion = moves.some((m) => m.velocity.x !== 0 || m.velocity.y !== 0);
    const currentGear = summary.gear;
    const bestClear = moves.reduce((max, m) => Math.max(max, m.clearAhead), 0);
    const { aggression, caution, gearBias, salt } = this.style;
    // Soft target: leave buffer vs runway; sqrt keeps gear modest into mid corners.
    const targetGear = Math.max(
      1,
      Math.min(6, Math.floor(Math.sqrt(Math.max(1, bestClear * 1.6))) + gearBias)
    );

    let best = moves[0];
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const move of moves) {
      let score = 0;

      if (hasMotion && move.velocity.x === 0 && move.velocity.y === 0) {
        score -= 50_000;
      }

      if (move.grassShortcut) score -= 10_000;
      if (move.landingTile === 'grass' || move.landingTile === 'rumble') score -= 5_000;

      if (summary.goal === 'checkpoint' && move.entersCheckpoint) score += 2_000;
      if (summary.goal === 'finish' && move.crossesFinish) score += 2_000;

      // Primary: progress along the track graph (not Euclidean to a centroid).
      score += move.pathProgress * 120;
      if (!Number.isFinite(move.pathDistance)) {
        score -= 10_000;
      } else {
        score -= move.pathDistance * 3;
      }

      // Legacy Chebyshev distance as a weak tie-break only.
      score -= move.distanceToGoal;

      if (move.overspeed) score -= 600 * caution;
      if (move.clearAhead === 0 && move.gear > 0) score -= 250 * caution;
      if (move.clearAhead <= 1 && move.gear >= 3) score -= 150 * caution;
      if (move.clearAhead <= 2 && move.gear >= 4) score -= 100 * caution;

      const delta = move.gear - currentGear;

      // Accelerate on open asphalt when under target.
      if (
        move.clearAhead >= 4 &&
        move.gear < targetGear &&
        delta > 0 &&
        !move.overspeed &&
        !move.grassShortcut
      ) {
        score += (55 + delta * 25) * aggression;
      }
      // Nudge off the line at the start.
      if (currentGear === 0 && move.gear === 1 && move.pathProgress > 0) {
        score += 60;
      }

      // Brake into corners / when runway is short.
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

      // Prefer carrying useful speed when the road is clear (secondary).
      if (move.clearAhead >= 5 && !move.overspeed) {
        score += move.gear * 4 * aggression;
      }

      // Style-salted micro tie-break so equal scores don't always pick moves[0].
      score += ((move.index * 31 + salt) % 11) * 0.05;

      if (score > bestScore) {
        bestScore = score;
        best = move;
      }
    }

    return Promise.resolve(best);
  }
}

// --------------------------------------------------------------- bedrock

const SYSTEM_PROMPT = `You are a race driver in Vector Rally, a grid-based racing game with momentum.
Each turn you pick ONE move from a numbered list of legal moves. Rules of thumb:
- NEVER pick velocity {"x":0,"y":0} unless it is the ONLY legal move — standing still wastes the turn.
- Moves flagged "grassShortcut" incur heavy penalties: avoid them unless every move has one.
- Before "passedCheckpoint" is true you must route through the checkpoint zone; prefer moves with "entersCheckpoint".
- After the checkpoint, head for the finish; moves with "crossesFinish" complete the lap.
- Prefer higher "pathProgress" and lower "pathDistance" (asphalt corridor toward the goal) — this is the racing line.
- Never pick negative pathProgress when a positive option exists (that is driving the wrong way).
- "clearAhead" is how many asphalt cells you can keep flying at the new velocity; accelerate when it is large, brake when it is small or "overspeed" is true.
- Lower "distanceToGoal" is a weak hint only; trust pathDistance over it.
Respond with ONLY a JSON object: {"moveIndex": <number>} — no prose.`;

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
}

/**
 * True when the model pick is clearly worse than the track-aware heuristic.
 * Nova Micro often crawls at gear 1, cuts grass, or turns against race direction.
 */
export function isDominatedByHeuristic(
  model: AnnotatedMove,
  heuristic: AnnotatedMove
): boolean {
  if (model.index === heuristic.index) return false;

  if (model.grassShortcut && !heuristic.grassShortcut) return true;
  if (model.overspeed && !heuristic.overspeed) return true;
  if (model.pathProgress < 0 && heuristic.pathProgress > 0) return true;
  if (model.pathProgress < heuristic.pathProgress - 0.25) return true;

  // Crawl on an open straight while the heuristic wants more speed.
  if (
    heuristic.clearAhead >= 4 &&
    model.gear < heuristic.gear &&
    model.pathProgress <= heuristic.pathProgress + 0.1
  ) {
    return true;
  }

  return false;
}

export class BedrockBrain implements MoveBrain {
  private readonly client: ConverseClient;
  private readonly fallback: MoveBrain;
  private readonly modelId: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(options: BedrockBrainOptions) {
    this.modelId = options.modelId;
    this.client =
      options.client ?? new BedrockRuntimeClient({ region: options.region });
    this.fallback =
      options.fallback ?? new HeuristicBrain(options.fallbackSeed ?? 'bedrock-fallback');
    this.maxTokens = options.maxTokens ?? 200;
    this.timeoutMs = options.timeoutMs ?? 6_000;
  }

  async pickMove(summary: BoardSummary, moves: AnnotatedMove[]): Promise<AnnotatedMove> {
    if (moves.length === 1) return moves[0];

    // Always know the safe pick first — used as floor quality and as recovery path.
    const heuristicPick = await this.fallback.pickMove(summary, moves);

    // While gear-capped (grass / off-track), skip the LLM — recovery must be fast
    // and correct; Nova Micro is slow and often freezes the turn UI.
    if (summary.gearLimited) {
      return heuristicPick;
    }

    try {
      const command = new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: SYSTEM_PROMPT }],
        messages: [
          {
            role: 'user',
            content: [{ text: this.buildPrompt(summary, moves) }],
          },
        ],
        inferenceConfig: { maxTokens: this.maxTokens, temperature: 0.2 },
      });

      const response = await this.sendWithTimeout(command);
      const text = response.output?.message?.content?.[0]?.text ?? '';
      const index = this.parseMoveIndex(text);

      if (index !== null && index >= 0 && index < moves.length) {
        const chosen = moves[index]!;
        const stationary = chosen.velocity.x === 0 && chosen.velocity.y === 0;
        const hasMotion = moves.some((m) => m.velocity.x !== 0 || m.velocity.y !== 0);
        if (stationary && hasMotion) {
          console.warn('[BRAIN] Model picked standstill — using heuristic');
          return heuristicPick;
        }
        if (isDominatedByHeuristic(chosen, heuristicPick)) {
          console.warn(
            `[BRAIN] Model pick dominated (gear=${chosen.gear} prog=${chosen.pathProgress.toFixed(2)} ` +
              `vs heuristic gear=${heuristicPick.gear} prog=${heuristicPick.pathProgress.toFixed(2)}) — using heuristic`
          );
          return heuristicPick;
        }
        return chosen;
      }
      console.warn(`[BRAIN] Model returned invalid move index (${text.slice(0, 80)}) — using heuristic`);
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

  private buildPrompt(summary: BoardSummary, moves: AnnotatedMove[]): string {
    return JSON.stringify({
      race: summary,
      legalMoves: moves.map((m) => ({
        moveIndex: m.index,
        velocity: m.velocity,
        landing: m.landing,
        gear: m.gear,
        landingTile: m.landingTile,
        grassShortcut: m.grassShortcut,
        entersCheckpoint: m.entersCheckpoint,
        crossesFinish: m.crossesFinish,
        distanceToGoal: m.distanceToGoal,
        pathDistance: Number.isFinite(m.pathDistance) ? m.pathDistance : null,
        pathProgress: m.pathProgress,
        clearAhead: m.clearAhead,
        overspeed: m.overspeed,
      })),
    });
  }

  private parseMoveIndex(text: string): number | null {
    // Models sometimes wrap JSON in fences or prose — grab the first object.
    const match = text.match(/\{[^{}]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]) as { moveIndex?: unknown };
      return typeof parsed.moveIndex === 'number' && Number.isInteger(parsed.moveIndex)
        ? parsed.moveIndex
        : null;
    } catch {
      return null;
    }
  }
}
