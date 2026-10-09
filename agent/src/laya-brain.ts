/**
 * Asks convaiinnovations/laya (via Ollaya /api/decide) to pick one of the
 * nine gear changes. A legal answer is replaced by the `best` asphalt step
 * when one exists, and by `back` when the car is already off the track.
 * Truncation, an illegal label, or a failed call still uses the heuristic.
 */
import { AiDifficulty, difficultyFromUnknown } from './difficulty';
import { HeuristicBrain, MoveBrain } from './brain';
import { supervisedChoice } from './bedrock-dataset';
import { LAYA_DECIDE_MODEL, layaDecideBody, LayaScene } from './laya-scene';
import { applySceneChoice } from './scene-choice';
import { adviseBoost, boostCap, playBoost, type BoostPick } from './boost-advice';
import type { AnnotatedMove, BoardSummary } from './tools';

export interface LayaEndpoint {
  url: string;
  apiKey?: string;
}

export interface LayaDecideResponse {
  answers?: { move?: { choice?: unknown }; boost?: { choice?: unknown } };
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
    this.model = options.model ?? LAYA_DECIDE_MODEL;
    this.timeoutMs = options.timeoutMs ?? 2_500;
    this.onFailure = options.onFailure;
  }

  async pickMove(summary: BoardSummary, moves: AnnotatedMove[]): Promise<AnnotatedMove> {
    const heuristic = () => this.fallback.pickMove(summary, moves);
    const scene = summary.scene;
    if (!scene || moves.length === 0) return heuristic();

    // The scene already names the step Laya would be overwritten with.
    // Asking Ollaya and then discarding the answer is what made each turn slow.
    const labeled = supervisedChoice(scene);
    if (labeled) {
      return this.tagBoost(summary, applySceneChoice('Laya', scene, moves, labeled, await heuristic()));
    }

    let target: LayaEndpoint | null;
    try {
      target = await this.endpoint();
    } catch (err) {
      console.warn('[BRAIN] Laya endpoint lookup failed — using heuristic:', errText(err));
      this.onFailure?.();
      return this.tagBoost(summary, await heuristic());
    }
    if (!target?.url) return this.tagBoost(summary, await heuristic());

    try {
      const body = await this.decide(target, scene);
      if (body.state_truncated) {
        console.warn('[BRAIN] Laya state was truncated — using heuristic');
        return this.tagBoost(summary, await heuristic());
      }
      const choice = body.answers?.move?.choice;
      const heuristicPick = await heuristic();
      const driven = applySceneChoice(
        'Laya',
        scene,
        moves,
        typeof choice === 'string' ? choice : null,
        heuristicPick
      );
      return this.tagBoost(summary, driven, body.answers?.boost?.choice);
    } catch (err) {
      console.warn('[BRAIN] Laya call failed — using heuristic:', errText(err));
      this.onFailure?.();
      return this.tagBoost(summary, await heuristic());
    }
  }

  /** Attach the boost the stretch pays for. A live answer cannot waste a bar the advice saved. */
  private tagBoost(summary: BoardSummary, move: AnnotatedMove, answered?: unknown): AnnotatedMove {
    const facts = {
      gear: summary.gear,
      nextGear: move.gear,
      clearAhead: move.clearAhead,
      overspeed:
        move.overspeed ||
        move.grassShortcut ||
        move.landingTile === 'grass' ||
        move.landingTile === 'rumble',
      gearLimited: summary.gearLimited,
      drsArmed: !!summary.drsArmed,
      drsActive: !!summary.drsActive,
      ersCharge: summary.ersCharge ?? 0,
      gap: summary.scene?.state.gap === 'lead' || typeof summary.scene?.state.gap === 'number'
        ? (summary.scene.state.gap as number | 'lead')
        : 'lead',
      blue: typeof summary.scene?.state.blue === 'number' ? summary.scene.state.blue : 0,
      bendCells: summary.situation.cellsToCorner,
      fuel: summary.fuel,
      pit: move.landingTile === 'pit' || move.landingTile === 'pitbox',
    };
    const advice = adviseBoost(facts);
    const live = isBoostPick(answered) ? answered : null;
    const pick =
      this.difficulty === 'hard' || this.difficulty === 'pro'
        ? acceptBoost(live, advice)
        : playBoost(this.difficulty, advice, facts);
    move.boostPick = pick;
    move.boostCap = boostCap(this.difficulty);
    return move;
  }

  private async decide(target: LayaEndpoint, scene: LayaScene): Promise<LayaDecideResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
    const body = JSON.stringify(layaDecideBody(scene, this.model));
    const started = Date.now();
    console.log(
      `[AI] weigh layaBytes=${Buffer.byteLength(body)} options=${scene.options?.length ?? 0} ` +
        `model=${this.model} timeoutMs=${this.timeoutMs}`
    );
    const response = await this.fetchImpl(`${target.url.replace(/\/$/, '')}/api/decide`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    console.log(`[AI] weigh layaStatus=${response.status} layaMs=${Date.now() - started}`);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollaya ${response.status}: ${text.slice(0, 180)}`);
    }
    return (await response.json()) as LayaDecideResponse;
  }
}

function isBoostPick(value: unknown): value is BoostPick {
  return value === 'save' || value === 'drs' || value === 'ers' || value === 'both';
}

/** A live answer may save a bar. It may not spend one the stretch does not pay for. */
function acceptBoost(live: BoostPick | null, advice: BoostPick): BoostPick {
  if (!live || live === advice) return advice;
  if (live === 'save') return 'save';
  if (advice === 'both' && (live === 'drs' || live === 'ers')) return live;
  return advice;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
