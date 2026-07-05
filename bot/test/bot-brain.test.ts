import { createLobbyPlayer, getValidMoves } from '../../shared/ws-types';
import { getTrackById } from '../../shared/tracks';
import { BotBrain } from '../src/bot-brain';

describe('BotBrain', () => {
  const track = getTrackById('monza')!;
  const player = createLobbyPlayer('bot', 'Bot', false, 1, '#3B82F6');
  player.position = { x: 12, y: 28 };
  player.velocity = { x: 0, y: 0 };

  it('returns acceleration in {-1,0,1} that matches a valid move', () => {
    const brain = new BotBrain();
    const car = {
      position: { ...player.position },
      velocity: { ...player.velocity },
      isOffTrack: false,
    };
    const trackState = { trackId: track.id, width: track.width, height: track.height };

    const { dx, dy } = brain.computeNextMove(car, trackState, track);
    expect(dx).toBeGreaterThanOrEqual(-1);
    expect(dx).toBeLessThanOrEqual(1);
    expect(dy).toBeGreaterThanOrEqual(-1);
    expect(dy).toBeLessThanOrEqual(1);

    const nextVelocity = { x: car.velocity.x + dx, y: car.velocity.y + dy };
    const valid = getValidMoves(player, track);
    expect(valid.some((m) => m.velocity.x === nextVelocity.x && m.velocity.y === nextVelocity.y)).toBe(
      true
    );
  });
});
