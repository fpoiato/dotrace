/**
 * Difficulty presets for Bot / IA pilots.
 *
 * easy    — slow, mistakes, low gear cap (practice opponent)
 * medium  — competent baseline, occasional slip
 * hard    — pushes gear, few/no intentional mistakes
 * pro     — near-optimal heuristic (and Bedrock when it matches)
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
    moveDelayMs: 320,
  },
  medium: {
    id: 'medium',
    maxGear: 5,
    aggression: 1.1,
    caution: 0.9,
    gearBias: 0,
    pathWeight: 140,
    clearToAccel: 3,
    clearSqrtScale: 1.8,
    mistakeChance: 0.08,
    topK: 2,
    moveDelayMs: 140,
  },
  hard: {
    id: 'hard',
    maxGear: 6,
    aggression: 1.6,
    caution: 0.7,
    gearBias: 1,
    pathWeight: 190,
    clearToAccel: 2,
    clearSqrtScale: 2.3,
    mistakeChance: 0,
    topK: 1,
    moveDelayMs: 60,
  },
  pro: {
    id: 'pro',
    maxGear: 6,
    aggression: 1.9,
    caution: 0.55,
    gearBias: 1,
    pathWeight: 220,
    clearToAccel: 2,
    clearSqrtScale: 2.6,
    mistakeChance: 0,
    topK: 1,
    moveDelayMs: 30,
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
