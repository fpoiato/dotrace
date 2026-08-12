import type { GameSession } from '../src/session';
import { raceLoop } from '../src/agent';
import type { MoveBrain } from '../src/brain';

describe('raceLoop handoff', () => {
  it('returns handoff immediately when shouldHandoff is already true', async () => {
    const dummy = {} as GameSession;
    const brain: MoveBrain = {
      pickMove: () => Promise.reject(new Error('brain should not run')),
    };
    const result = await raceLoop(dummy, brain, 0, { shouldHandoff: () => true });
    expect(result).toBe('handoff');
  });
});
