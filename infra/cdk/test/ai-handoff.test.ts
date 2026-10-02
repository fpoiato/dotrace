import { handoffMarkerId, isAiMarker, isGhost, isHandoffMarker, isLiveSocket } from '../lambda/src/lib/ddb';
import { stopStillValid } from '../lambda/src/ollaya-power';

describe('AI handoff markers', () => {
  it('uses a distinct prefix from ghosts and spawn markers', () => {
    const id = handoffMarkerId('ABCDE', 'Bot Alfa · Difícil');
    expect(isHandoffMarker(id)).toBe(true);
    expect(isGhost(id)).toBe(false);
    expect(isAiMarker(id)).toBe(false);
    expect(id).toBe(handoffMarkerId('ABCDE', 'bot alfa · difícil'));
  });
});

describe('Ollaya power policy', () => {
  it('counts only live sockets', () => {
    expect(isLiveSocket('conn-1')).toBe(true);
    expect(isLiveSocket('ghost#ABCDE#ada')).toBe(false);
    expect(isLiveSocket('aimark#ABCDE#bot')).toBe(false);
    expect(isLiveSocket('aihand#ABCDE#bot')).toBe(false);
    expect(isLiveSocket('sys#ollaya')).toBe(false);
    expect(isGhost('ghost#x')).toBe(true);
    expect(isAiMarker('aimark#x')).toBe(true);
    expect(isHandoffMarker('aihand#x')).toBe(true);
  });

  it('stops only when this request is still the latest and the room is empty', () => {
    expect(
      stopStillValid({
        eventGeneration: 4,
        currentGeneration: 4,
        desired: 'stopped',
        liveSockets: 0,
      })
    ).toBe(true);
    expect(
      stopStillValid({
        eventGeneration: 4,
        currentGeneration: 5,
        desired: 'stopped',
        liveSockets: 0,
      })
    ).toBe(false);
    expect(
      stopStillValid({
        eventGeneration: 4,
        currentGeneration: 4,
        desired: 'running',
        liveSockets: 0,
      })
    ).toBe(false);
    expect(
      stopStillValid({
        eventGeneration: 4,
        currentGeneration: 4,
        desired: 'stopped',
        liveSockets: 1,
      })
    ).toBe(false);
  });
});
