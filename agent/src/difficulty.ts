/**
 * Difficulty presets for Bot / IA pilots.
 *
 * easy    — slow, mistakes, low gear cap (practice opponent)
 * medium  — current track-aware baseline
 * hard    — sharper line, fewer mistakes, higher speed
 * pro     — near-optimal heuristic (and Bedrock only when it matches)
 */

export const AI_DIFFICULTIES = ['easy', 'medium', 'hard', 'pro'] as const;
export type AiDifficulty = (typeof AI_DIFFICULTIES)[number];

export function isAiDifficulty(value: unknown): value is AiDifficulty {
  return typeof value === 'string' && (AI_DIFFICULTIES as readonly string[]).includes(value);
}

export interface DifficultyTuning {
  id: AiDifficulty;
  /** Hard cap on Chebyshev gear. */
  maxGear: number;
  /** Multiplier on acceleration scoring. */
  aggression: number;
  /** Multiplier on braking / overspeed penalties. */
  caution: number;
  /** Soft ± nudge on target gear from look-ahead. */
  gearBias: number;
  /** Weight on pathProgress (racing-line advancement). */
  pathWeight: number;
  /** Min clearAhead cells before rewarding acceleration. */
  clearToAccel: number;
  /** Scale inside sqrt(clear * scale) for target gear. */
  clearSqrtScale: number;
  /** Probability of picking a suboptimal move among the top-K. */
  mistakeChance: number;
  /** How many top-scoring clean moves can be chosen when mistaking. */
  topK: number;
  /** Artificial think delay before submitting (ms). */
  moveDelayMs: number;
}

export const DIFFICULTY_TUNING: Record<AiDifficulty, DifficultyTuning> = {
  easy: {
    id: 'easy',
    maxGear: 3,
    aggression: 0.55,
    caution: 1.35,
    gearBias: -1,
    pathWeight: 70,
    clearToAccel: 6,
    clearSqrtScale: 1.0,
    mistakeChance: 0.45,
    topK: 3,
    moveDelayMs: 900,
  },
  medium: {
    id: 'medium',
    maxGear: 5,
    aggression: 1.0,
    caution: 1.0,
    gearBias: 0,
    pathWeight: 120,
    clearToAccel: 4,
    clearSqrtScale: 1.6,
    mistakeChance: 0.12,
    topK: 2,
    moveDelayMs: 600,
  },
  hard: {
    id: 'hard',
    maxGear: 6,
    aggression: 1.25,
    caution: 1.15,
    gearBias: 0,
    pathWeight: 140,
    clearToAccel: 3,
    clearSqrtScale: 1.85,
    mistakeChance: 0.04,
    topK: 2,
    moveDelayMs: 450,
  },
  pro: {
    id: 'pro',
    maxGear: 6,
    aggression: 1.45,
    caution: 1.25,
    gearBias: 1,
    pathWeight: 170,
    clearToAccel: 3,
    clearSqrtScale: 2.1,
    mistakeChance: 0,
    topK: 1,
    moveDelayMs: 350,
  },
};

/** Short suffix for nicknames, e.g. "Bot Alfa · Pro". */
export const DIFFICULTY_NICK_SUFFIX: Record<AiDifficulty, string> = {
  easy: 'Fácil',
  medium: 'Médio',
  hard: 'Difícil',
  pro: 'Pro',
};

export function difficultyFromUnknown(value: unknown, fallback: AiDifficulty = 'medium'): AiDifficulty {
  return isAiDifficulty(value) ? value : fallback;
}
