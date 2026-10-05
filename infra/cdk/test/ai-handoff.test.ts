import {
  aiSeatId,
  classifySeatRead,
  handoffMarkerId,
  isAiMarker,
  isAiSeat,
  isGhost,
  isHandoffMarker,
  isLiveSocket,
} from '../lambda/src/lib/ddb';
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

describe('AI seats', () => {
  it('keys a seat by room and nickname without colliding with sockets', () => {
    const id = aiSeatId('abcde', 'IA Nova · Pro');
    expect(id).toBe('ai#ABCDE#ia nova · pro');
    expect(id).toBe(aiSeatId('ABCDE', 'ia nova · pro'));
    expect(isLiveSocket(id)).toBe(false);
    expect(isGhost(id)).toBe(false);
    expect(isAiMarker(id)).toBe(false);
  });

  it('treats a matching saved vector as cached and anything else as busy', () => {
    expect(classifySeatRead({ lastToken: 'r1', lastVx: 1, lastVy: 0 }, 'r1')).toBe('cached');
    expect(classifySeatRead({ lastToken: 'r1', lastVx: 1, lastVy: 0 }, 'r2')).toBe('busy');
    expect(classifySeatRead({ lastToken: 'r1' }, 'r1')).toBe('busy');
    expect(classifySeatRead(undefined, 'r1')).toBe('busy');
  });
});

describe('Ollaya power policy', () => {
  it('counts only live sockets', () => {
    expect(isLiveSocket('conn-1')).toBe(true);
    expect(isLiveSocket('ghost#ABCDE#ada')).toBe(false);
    expect(isLiveSocket('aimark#ABCDE#bot')).toBe(false);
    expect(isLiveSocket('aihand#ABCDE#bot')).toBe(false);
    expect(isLiveSocket('sys#ollaya')).toBe(false);
    expect(isLiveSocket('ai#ABCDE#bot alfa')).toBe(false);
    expect(isAiSeat('ai#ABCDE#bot alfa')).toBe(true);
    expect(isAiSeat('aimark#ABCDE#bot')).toBe(false);
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
