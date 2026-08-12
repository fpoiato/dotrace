import {
  handoffMarkerId,
  isAiMarker,
  isGhost,
  isHandoffMarker,
} from '../lambda/src/lib/ddb';

describe('AI handoff markers', () => {
  it('uses a distinct prefix from ghosts and spawn markers', () => {
    const id = handoffMarkerId('ABCDE', 'Bot Alfa · Difícil');
    expect(isHandoffMarker(id)).toBe(true);
    expect(isGhost(id)).toBe(false);
    expect(isAiMarker(id)).toBe(false);
    expect(id).toBe(handoffMarkerId('ABCDE', 'bot alfa · difícil'));
  });
});
