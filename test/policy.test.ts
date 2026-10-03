import { isLiveSocket } from '../lambda/src/legacy';
import {
  legacyIsActive,
  otherActiveConsumers,
  requesterIsIdle,
  shouldStop,
  stopStillValid,
} from '../lambda/src/policy';

describe('legacy Dot Race stop rule', () => {
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

  it('ignores Dot Race rows that are not open sockets', () => {
    expect(isLiveSocket('conn-1')).toBe(true);
    expect(isLiveSocket('ghost#ABCDE#ada')).toBe(false);
    expect(isLiveSocket('aimark#ABCDE#bot')).toBe(false);
    expect(isLiveSocket('aihand#ABCDE#bot')).toBe(false);
    expect(isLiveSocket('sys#ollaya')).toBe(false);
  });
});

describe('shared stop policy', () => {
  it('keeps the machine up while another project holds a lease', () => {
    const idle = requesterIsIdle({
      legacy: true,
      eventGeneration: 4,
      legacyControl: { generation: 4, desired: 'stopped' },
      liveSockets: 0,
    });
    const others = otherActiveConsumers({
      requester: 'dotrace',
      leases: [{ consumer: 'truco', generation: 2, desired: 'running' }],
      legacyActive: false,
    });
    expect(shouldStop(idle, others)).toBe(false);
  });

  it('does not let a project stop the machine while Dot Race still has players', () => {
    const idle = requesterIsIdle({
      legacy: false,
      eventGeneration: 3,
      liveSockets: 2,
      ownLease: { consumer: 'truco', generation: 3, desired: 'stopped' },
    });
    const others = otherActiveConsumers({
      requester: 'truco',
      leases: [{ consumer: 'truco', generation: 3, desired: 'stopped' }],
      legacyActive: legacyIsActive({ generation: 9, desired: 'running' }, 2),
    });
    expect(idle).toBe(true);
    expect(shouldStop(idle, others)).toBe(false);
  });

  it('stops when the caller is still idle and nobody else is running', () => {
    const idle = requesterIsIdle({
      legacy: false,
      eventGeneration: 3,
      liveSockets: 0,
      ownLease: { consumer: 'truco', generation: 3, desired: 'stopped' },
    });
    const others = otherActiveConsumers({
      requester: 'truco',
      leases: [{ consumer: 'truco', generation: 3, desired: 'stopped' }],
      legacyActive: legacyIsActive({ generation: 4, desired: 'stopped' }, 0),
    });
    expect(shouldStop(idle, others)).toBe(true);
  });

  it('ignores a stale stop after a newer start from the same project', () => {
    expect(
      requesterIsIdle({
        legacy: false,
        eventGeneration: 3,
        liveSockets: 0,
        ownLease: { consumer: 'truco', generation: 4, desired: 'running' },
      })
    ).toBe(false);
  });

  it('refuses a legacy stop that did not carry a generation', () => {
    expect(
      requesterIsIdle({
        legacy: true,
        eventGeneration: undefined,
        legacyControl: { generation: 1, desired: 'stopped' },
        liveSockets: 0,
      })
    ).toBe(false);
  });
});
