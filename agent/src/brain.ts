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
 * Deterministic racer: never cut grass, chase the checkpoint before the
 * finish, otherwise minimize distance to the goal at the highest safe gear.
 * Prefer moving over standing still when any non-zero legal move exists.
 */
export class HeuristicBrain implements MoveBrain {
  pickMove(summary: BoardSummary, moves: AnnotatedMove[]): Promise<AnnotatedMove> {
    const hasMotion = moves.some((m) => m.velocity.x !== 0 || m.velocity.y !== 0);
    let best = moves[0];
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const move of moves) {
      let score = 0;

      // Standing still is legal but wastes the turn — only keep it as last resort.
      if (hasMotion && move.velocity.x === 0 && move.velocity.y === 0) {
        score -= 50_000;
      }

      // Legal-but-costly moves: grass shortcuts stop the car and cap the gear.
      if (move.grassShortcut) score -= 10_000;
      if (move.landingTile === 'grass' || move.landingTile === 'rumble') score -= 5_000;

      // Lap progress beats raw speed.
      if (summary.goal === 'checkpoint' && move.entersCheckpoint) score += 2_000;
      if (summary.goal === 'finish' && move.crossesFinish) score += 2_000;

      score -= move.distanceToGoal * 10;
      score += move.gear; // tiebreak: carry speed

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
- Lower "distanceToGoal" is better; higher "gear" is faster but harder to brake later.
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
