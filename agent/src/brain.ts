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

/**
 * Track-aware racer:
 * - Follow the asphalt corridor via BFS pathDistance / pathProgress
 * - Accelerate when clearAhead is long and under a soft target speed
 * - Brake when overspeed or the runway ahead is short
 * - Never prefer grass shortcuts when a clean move exists
 */
export class HeuristicBrain implements MoveBrain {
  pickMove(summary: BoardSummary, moves: AnnotatedMove[]): Promise<AnnotatedMove> {
    const hasMotion = moves.some((m) => m.velocity.x !== 0 || m.velocity.y !== 0);
    const currentGear = summary.gear;
    const bestClear = moves.reduce((max, m) => Math.max(max, m.clearAhead), 0);
    // Soft target: leave buffer vs runway; sqrt keeps gear modest into mid corners.
    const targetGear = Math.max(
      1,
      Math.min(6, Math.floor(Math.sqrt(Math.max(1, bestClear * 1.6))))
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

      if (move.overspeed) score -= 600;
      if (move.clearAhead === 0 && move.gear > 0) score -= 250;
      if (move.clearAhead <= 1 && move.gear >= 3) score -= 150;
      if (move.clearAhead <= 2 && move.gear >= 4) score -= 100;

      const delta = move.gear - currentGear;

      // Accelerate on open asphalt when under target.
      if (
        move.clearAhead >= 4 &&
        move.gear < targetGear &&
        delta > 0 &&
        !move.overspeed &&
        !move.grassShortcut
      ) {
        score += 55 + delta * 25;
      }
      // Nudge off the line at the start.
      if (currentGear === 0 && move.gear === 1 && move.pathProgress > 0) {
        score += 60;
      }

      // Brake into corners / when runway is short.
      if ((move.overspeed || move.clearAhead <= 2) && delta < 0) {
        score += 70 + Math.abs(delta) * 25;
      }
      if (move.clearAhead <= 3 && delta > 0) {
        score -= 80 * delta;
      }
      if (move.gear >= 3 && move.clearAhead < move.gear) {
        score -= 45 * (move.gear - move.clearAhead);
      }

      if (move.pathProgress < 0) score -= 100;

      // Prefer carrying useful speed when the road is clear (secondary).
      if (move.clearAhead >= 5 && !move.overspeed) {
        score += move.gear * 4;
      }

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
}

export class BedrockBrain implements MoveBrain {
  private readonly client: ConverseClient;
  private readonly fallback: MoveBrain;
  private readonly modelId: string;
  private readonly maxTokens: number;

  constructor(options: BedrockBrainOptions) {
    this.modelId = options.modelId;
    this.client =
      options.client ?? new BedrockRuntimeClient({ region: options.region });
    this.fallback = options.fallback ?? new HeuristicBrain();
    this.maxTokens = options.maxTokens ?? 200;
  }

  async pickMove(summary: BoardSummary, moves: AnnotatedMove[]): Promise<AnnotatedMove> {
    if (moves.length === 1) return moves[0];

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

      const response = await this.client.send(command);
      const text = response.output?.message?.content?.[0]?.text ?? '';
      const index = this.parseMoveIndex(text);

      if (index !== null && index >= 0 && index < moves.length) {
        const chosen = moves[index];
        // Nova Micro often "plays safe" with (0,0). That is legal but looks
        // like the pilot skipped — fall back when any moving option exists.
        const stationary = chosen.velocity.x === 0 && chosen.velocity.y === 0;
        const hasMotion = moves.some((m) => m.velocity.x !== 0 || m.velocity.y !== 0);
        if (stationary && hasMotion) {
          console.warn('[BRAIN] Model picked standstill — using heuristic');
          return this.fallback.pickMove(summary, moves);
        }
        return chosen;
      }
      console.warn(`[BRAIN] Model returned invalid move index (${text.slice(0, 80)}) — using heuristic`);
    } catch (err) {
      console.warn('[BRAIN] Bedrock call failed — using heuristic:', err instanceof Error ? err.message : err);
    }
    return this.fallback.pickMove(summary, moves);
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
