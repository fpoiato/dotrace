/**
 * Host-local / headless computer opponent for Dot Race.
 * Picks among legal getValidMoves using a greedy distance heuristic
 * that respects the checkpoint gate and prefers staying on track.
 */
import {
  CheckpointRect,
  Player,
  TrackDefinition,
  Vector2D,
  gearOf,
  getTileAt,
  getValidMoves,
  isGrassShortcut,
} from './ws-types';

export interface BotMoveInput {
  player: Player;
  track: TrackDefinition;
  others: Player[];
  round: number;
}

function rectCentroid(rect: CheckpointRect): Vector2D {
  return {
    x: Math.round((rect.x0 + rect.x1) / 2),
    y: Math.round((rect.y0 + rect.y1) / 2),
  };
}

function finishCentroid(track: TrackDefinition): Vector2D {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let y = 0; y < track.height; y++) {
    for (let x = 0; x < track.width; x++) {
      if (track.grid[y][x] === 'finish') {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }
  if (count > 0) {
    return { x: Math.round(sumX / count), y: Math.round(sumY / count) };
  }
  return { x: Math.floor(track.width / 2), y: Math.floor(track.height / 2) };
}

/** Current navigation goal: far-side checkpoint first, then finish stripe. */
export function botGoal(player: Player, track: TrackDefinition): Vector2D {
  if (track.checkpoint && !player.passedCheckpoint) {
    return rectCentroid(track.checkpoint);
  }
  return finishCentroid(track);
}

function manhattan(a: Vector2D, b: Vector2D): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Choose the next velocity vector for a computer opponent.
 * Always returns one of getValidMoves (including the emergency stop).
 */
export function chooseBotVelocity(input: BotMoveInput): Vector2D {
  const { player, track, others, round } = input;
  const moves = getValidMoves(player, track, others, round);
  if (moves.length === 0) {
    return { x: 0, y: 0 };
  }

  const goal = botGoal(player, track);
  let best = moves[0];
  let bestScore = Number.POSITIVE_INFINITY;

  for (const move of moves) {
    const tile = getTileAt(track, move.landing.x, move.landing.y);
    const distance = manhattan(move.landing, goal);
    const gear = gearOf(move.velocity);
    let score = distance;

    // Softly prefer carrying speed when still far from the goal.
    if (distance > 8) {
      score -= gear * 0.35;
    }

    if (tile === 'grass' || tile === 'rumble') {
      score += 40;
    } else if (tile === 'track' || tile === 'finish') {
      score -= 1;
    }

    if (isGrassShortcut(track, player.position, move.landing)) {
      score += 25;
    }

    // When stuck off-track, heavily prefer landing back on asphalt.
    if (player.isOffTrack && (tile === 'track' || tile === 'finish')) {
      score -= 30;
    }

    if (score < bestScore) {
      bestScore = score;
      best = move;
    }
  }

  return { ...best.velocity };
}

/** Thin class wrapper kept for the headless Agentive Client. */
export class BotBrain {
  computeNextVelocity(input: BotMoveInput): Vector2D {
    return chooseBotVelocity(input);
  }

  /**
   * Acceleration form used by the standalone bot process
   * (server validates absolute velocity, not Δv).
   */
  computeNextMove(
    carState: Pick<Player, 'position' | 'velocity' | 'isOffTrack' | 'passedCheckpoint'>,
    track: TrackDefinition,
    others: Player[] = [],
    round = 1,
    connectionId = 'bot'
  ): { dx: number; dy: number } {
    const player: Player = {
      connectionId,
      nickname: 'Bot',
      color: '#3B82F6',
      isHost: false,
      joinOrder: 0,
      status: 'approved',
      position: { ...carState.position },
      velocity: { ...carState.velocity },
      isOffTrack: carState.isOffTrack,
      trail: [],
      lap: 1,
      passedCheckpoint: carState.passedCheckpoint,
      isBot: true,
    };
    const next = chooseBotVelocity({ player, track, others, round });
    return {
      dx: next.x - carState.velocity.x,
      dy: next.y - carState.velocity.y,
    };
  }
}
