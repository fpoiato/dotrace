/**
 * Asks convaiinnovations/laya (via Ollaya /api/decide) to pick one of the
 * nine gear changes. Any failure, truncated state, or illegal label falls
 * back to the heuristic so a turn is never stuck on the model.
 */
import { AiDifficulty, difficultyFromUnknown } from './difficulty';
import { HeuristicBrain, MoveBrain } from './brain';
import { LAYA_MOVE_INSTRUCTIONS, LayaScene, parseMoveLabel } from './laya-scene';
import type { AnnotatedMove, BoardSummary } from './tools';

export interface LayaEndpoint {
  url: string;
  apiKey?: string;
}

export interface LayaDecideResponse {
  answers?: { move?: { choice?: unknown } };
  state_truncated?: boolean;
}

export interface LayaBrainOptions {
  endpoint: () => Promise<LayaEndpoint | null>;
  /** Injectable HTTP implementation. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  fallback?: MoveBrain;
  fallbackSeed?: string;
  difficulty?: AiDifficulty;
  model?: string;
  timeoutMs?: number;
  /** Called when the HTTP call fails so the caller can drop a stale URL. */
  onFailure?: () => void;
}

export class LayaBrain implements MoveBrain {
  private readonly endpoint: () => Promise<LayaEndpoint | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly fallback: MoveBrain;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly onFailure?: () => void;
  readonly difficulty: AiDifficulty;

  constructor(options: LayaBrainOptions) {
    this.endpoint = options.endpoint;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.difficulty = difficultyFromUnknown(options.difficulty);
    this.fallback =
      options.fallback ??
      new HeuristicBrain({
        styleOrSeed: options.fallbackSeed ?? 'laya-fallback',
        difficulty: this.difficulty,
      });
    this.model = options.model ?? 'laya';
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.onFailure = options.onFailure;
  }

  async pickMove(summary: BoardSummary, moves: AnnotatedMove[]): Promise<AnnotatedMove> {
    const heuristic = () => this.fallback.pickMove(summary, moves);
    const scene = summary.scene;
    if (!scene || moves.length === 0) return heuristic();

    let target: LayaEndpoint | null;
    try {
      target = await this.endpoint();
    } catch (err) {
      console.warn('[BRAIN] Laya endpoint lookup failed — using heuristic:', errText(err));
      this.onFailure?.();
      return heuristic();
    }
    if (!target?.url) return heuristic();

    try {
      const body = await this.decide(target, scene);
      if (body.state_truncated) {
        console.warn('[BRAIN] Laya state was truncated — using heuristic');
        return heuristic();
      }
      const choice = body.answers?.move?.choice;
      if (typeof choice !== 'string' || !parseMoveLabel(choice)) {
        console.warn(`[BRAIN] Laya returned no move label (${JSON.stringify(choice)}) — using heuristic`);
        return heuristic();
      }
      const option = scene.options.find((item) => item.label === choice);
      if (!option || option.illegal) {
        console.warn(`[BRAIN] Laya picked ${choice} which is illegal — using heuristic`);
        return heuristic();
      }
      const match = moves.find(
        (move) => move.velocity.x === option.velocity.x && move.velocity.y === option.velocity.y
      );
      if (!match) {
        console.warn(`[BRAIN] Laya picked ${choice} which is not a legal move — using heuristic`);
        return heuristic();
      }
      return match;
    } catch (err) {
      console.warn('[BRAIN] Laya call failed — using heuristic:', errText(err));
      this.onFailure?.();
      return heuristic();
    }
  }

  private async decide(target: LayaEndpoint, scene: LayaScene): Promise<LayaDecideResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
    const response = await this.fetchImpl(`${target.url.replace(/\/$/, '')}/api/decide`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        state: scene.state,
        questions: {
          move: {
            type: 'choice',
            instructions: LAYA_MOVE_INSTRUCTIONS,
            criteria: Object.fromEntries(scene.options.map((option) => [option.label, option.detail])),
          },
        },
        keep_alive: '-1',
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollaya ${response.status}: ${text.slice(0, 180)}`);
    }
    return (await response.json()) as LayaDecideResponse;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
