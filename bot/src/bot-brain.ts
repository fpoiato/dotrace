import {
  getTileAt,
  getValidMoves,
  landingPosition,
  type Player,
  type TileType,
  type Vector2D,
} from '../../shared/ws-types.ts';
import type { Acceleration, CarState, MoveDecision, TrackState } from './types.ts';

interface CandidateMove {
  acceleration: Acceleration;
  velocity: Vector2D;
  landing: Vector2D;
  tile: TileType;
}

const ACCELERATIONS: Acceleration[] = [-1, 0, 1].flatMap((dx) =>
  [-1, 0, 1].map((dy) => ({ dx, dy }))
);

export class BotBrain {
  computeNextMove(carState: CarState, trackState: TrackState): Acceleration {
    return this.computeNextDecision(carState, trackState).acceleration;
  }

  computeNextDecision(
    carState: CarState,
    trackState: TrackState,
    players: Player[] = []
  ): MoveDecision {
    const candidates = this.enumerateCandidateMoves(carState, trackState, players);

    if (candidates.length === 0) {
      return this.emergencyStop(carState, trackState, players);
    }

    const target = this.pickTarget(carState, trackState);
    const ranked = candidates
      .map((candidate) => ({
        candidate,
        score: this.scoreCandidate(candidate, target),
      }))
      .sort((a, b) => a.score - b.score);

    const bestScore = ranked[0].score;
    const tied = ranked.filter((entry) => Math.abs(entry.score - bestScore) < 0.0001);
    const chosen = tied[Math.floor(Math.random() * tied.length)].candidate;

    return {
      acceleration: chosen.acceleration,
      velocity: chosen.velocity,
      landing: chosen.landing,
      reason: `greedy target (${target.x},${target.y})`,
    };
  }

  private enumerateCandidateMoves(
    carState: CarState,
    trackState: TrackState,
    players: Player[]
  ): CandidateMove[] {
    const legalVelocityKeys = new Set(
      getValidMoves(toPlayer(carState), trackState, players).map((move) =>
        vectorKey(move.velocity)
      )
    );

    return ACCELERATIONS.flatMap((acceleration) => {
      const velocity = {
        x: carState.velocity.x + acceleration.dx,
        y: carState.velocity.y + acceleration.dy,
      };
      const landing = landingPosition(carState.position, velocity);
      const tile = getTileAt(trackState, landing.x, landing.y);

      // The host accepts velocity vectors, so we mirror its move validator here
      // while keeping the acceleration delta for logging and decision output.
      if (!tile || !legalVelocityKeys.has(vectorKey(velocity))) {
        return [];
      }

      return [{ acceleration, velocity, landing, tile }];
    });
  }

  private emergencyStop(
    carState: CarState,
    trackState: TrackState,
    players: Player[]
  ): MoveDecision {
    const stop = getValidMoves(toPlayer(carState), trackState, players)[0];
    const velocity = stop?.velocity ?? { x: 0, y: 0 };
    const landing = stop?.landing ?? { ...carState.position };

    return {
      acceleration: {
        dx: velocity.x - carState.velocity.x,
        dy: velocity.y - carState.velocity.y,
      },
      velocity,
      landing,
      reason: 'emergency stop',
    };
  }

  private pickTarget(carState: CarState, trackState: TrackState): Vector2D {
    if (trackState.checkpoint && carState.passedCheckpoint !== true) {
      return {
        x: (trackState.checkpoint.x0 + trackState.checkpoint.x1) / 2,
        y: (trackState.checkpoint.y0 + trackState.checkpoint.y1) / 2,
      };
    }

    const finishCells: Vector2D[] = [];
    for (let y = 0; y < trackState.height; y++) {
      for (let x = 0; x < trackState.width; x++) {
        if (trackState.grid[y]?.[x] === 'finish') {
          finishCells.push({ x, y });
        }
      }
    }

    return nearestTo(carState.position, finishCells) ?? {
      x: Math.floor(trackState.width / 2),
      y: Math.floor(trackState.height / 2),
    };
  }

  private scoreCandidate(candidate: CandidateMove, target: Vector2D): number {
    const dx = candidate.landing.x - target.x;
    const dy = candidate.landing.y - target.y;
    const distance = Math.hypot(dx, dy);
    const grassPenalty = candidate.tile === 'grass' ? 8 : 0;
    const speed = Math.hypot(candidate.velocity.x, candidate.velocity.y);

    return distance + grassPenalty - speed * 0.05;
  }
}

function toPlayer(carState: CarState): Player {
  return {
    connectionId: carState.id,
    nickname: carState.nickname,
    color: '#000000',
    isHost: false,
    joinOrder: 0,
    status: 'approved',
    position: { ...carState.position },
    velocity: { ...carState.velocity },
    isOffTrack: carState.isOffTrack,
    trail: [],
    lap: 1,
    passedCheckpoint: carState.passedCheckpoint,
    finishOrder: carState.finishOrder,
  };
}

function nearestTo(origin: Vector2D, points: Vector2D[]): Vector2D | null {
  let nearest: Vector2D | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
    if (distance < bestDistance) {
      nearest = point;
      bestDistance = distance;
    }
  }
  return nearest;
}

function vectorKey(vector: Vector2D): string {
  return `${vector.x},${vector.y}`;
}
