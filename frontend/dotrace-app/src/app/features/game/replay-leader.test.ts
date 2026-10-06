/**
 * Run: npx tsx frontend/dotrace-app/src/app/features/game/replay-leader.test.ts
 */
import type { TrackDefinition, Vector2D } from '../../core/models/ws-types';
import { getTrackById } from '../../core/models/tracks';
import { leadingPlayerId, type RaceProgressCar } from './replay-leader';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function car(
  id: string,
  x: number,
  lap: number,
  extra: Partial<RaceProgressCar> = {}
): RaceProgressCar {
  return {
    connectionId: id,
    nickname: id,
    position: { x, y: 0 },
    lap,
    ...extra,
  };
}

/** Straight out and back, so arc progress grows with x then wraps at the end. */
const straight: TrackDefinition = {
  id: 'straight',
  nameKey: 'straight',
  width: 21,
  height: 3,
  grid: [],
  startLine: [],
  arrows: [],
  centerline: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
    { x: 0, y: 0 },
  ] as Vector2D[],
};

assert(leadingPlayerId([], straight) === undefined, 'empty field');

assert(
  leadingPlayerId([car('back', 2, 1), car('front', 14, 1)], straight) === 'front',
  'same lap: further along the straight leads'
);

assert(
  leadingPlayerId([car('lapped', 18, 1), car('leader', 1, 2)], straight) === 'leader',
  'higher lap leads even when it just left the stripe'
);

assert(
  leadingPlayerId(
    [
      car('winner', 1, 3, { finishRound: 10 }),
      car('chase', 12, 3, { finishRound: 14 }),
    ],
    straight,
    12
  ) === 'chase',
  'a car that already finished yields the camera to whoever is still racing'
);

assert(
  leadingPlayerId(
    [car('winner', 1, 3, { finishRound: 10 }), car('chase', 12, 2)],
    straight,
    9
  ) === 'winner',
  'before the finish round the leader is still the car on the higher lap'
);

const inter = getTrackById('interlagos');
assert(inter, 'interlagos missing');
assert(
  leadingPlayerId(
    [
      { connectionId: 'grid', nickname: 'Grid', position: { x: 63, y: 18 }, lap: 1 },
      { connectionId: 'senna', nickname: 'Senna', position: { x: 23, y: 52 }, lap: 1 },
    ],
    inter!
  ) === 'senna',
  'interlagos: the car into Senna S leads the one still on the grid'
);

console.log('replay leader: ok');
