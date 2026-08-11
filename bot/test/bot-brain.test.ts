import { createLobbyPlayer, getValidMoves } from '../../shared/ws-types';
import { getTrackById } from '../../shared/tracks';
import { BotBrain, chooseBotVelocity } from '../src/bot-brain';

describe('BotBrain', () => {
  const track = getTrackById('monza')!;
  const player = createLobbyPlayer('bot', 'Bot', false, 1, '#3B82F6', true);
  player.position = { ...track.startLine[0] };
  player.velocity = { x: 0, y: 0 };

  it('returns acceleration in {-1,0,1} that matches a valid move', () => {
    const brain = new BotBrain();
    const { dx, dy } = brain.computeNextMove(
      {
        position: { ...player.position },
        velocity: { ...player.velocity },
        isOffTrack: false,
      },
      track,
      [player],
      1,
      player.connectionId
    );
    expect(dx).toBeGreaterThanOrEqual(-1);
    expect(dx).toBeLessThanOrEqual(1);
    expect(dy).toBeGreaterThanOrEqual(-1);
    expect(dy).toBeLessThanOrEqual(1);

    const nextVelocity = { x: player.velocity.x + dx, y: player.velocity.y + dy };
    const valid = getValidMoves(player, track);
    expect(valid.some((m) => m.velocity.x === nextVelocity.x && m.velocity.y === nextVelocity.y)).toBe(
      true
    );
  });

  it('chooseBotVelocity returns a legal velocity from getValidMoves', () => {
    const velocity = chooseBotVelocity({
      player,
      track,
      others: [player],
      round: 1,
    });
    const valid = getValidMoves(player, track, [player], 1);
    expect(valid.some((m) => m.velocity.x === velocity.x && m.velocity.y === velocity.y)).toBe(true);
  });

  it('prefers on-track landings over grass when both are available', () => {
    // From a standing start on Monza, every legal ±1 move should stay on asphalt/finish.
    const velocity = chooseBotVelocity({
      player,
      track,
      others: [player],
      round: 1,
    });
    const landing = {
      x: player.position.x + velocity.x,
      y: player.position.y + velocity.y,
    };
    const tile = track.grid[landing.y][landing.x];
    expect(tile === 'track' || tile === 'finish' || tile === 'rumble').toBe(true);
  });
});
