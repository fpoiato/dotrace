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

  it('asks for the board when the race state has not arrived yet', async () => {
    let asks = 0;
    const session = {
      getState: () => null,
      requestRaceState: () => {
        asks += 1;
        return Promise.resolve();
      },
      waitUntilRacing: () => Promise.reject(new Error('Timed out waiting for race start')),
    } as unknown as GameSession;
    const brain: MoveBrain = {
      pickMove: () => Promise.reject(new Error('brain should not run')),
    };
    const result = await raceLoop(session, brain, 0, {
      waitSliceMs: 1,
      shouldHandoff: () => asks > 0,
    });
    expect(result).toBe('handoff');
    expect(asks).toBe(1);
  });
});
