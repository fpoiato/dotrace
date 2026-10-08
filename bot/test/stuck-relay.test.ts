import { WsEnvelope } from '../../shared/ws-types';
import { parseRelayEnvelope } from '../src/state-parser';

describe('stuck relay', () => {
  const envelope: WsEnvelope = {
    action: 'RELAY',
    roomCode: 'ABCDE',
    payload: {
      type: 'STATE_SYNC',
      state: {
        phase: 'GAME_ROUND',
        gameMode: 'TURNS',
        round: 2,
        currentTurnIndex: 0,
        turnOrder: ['bot-1'],
        trackId: 'monza',
        players: [
          {
            connectionId: 'bot-1',
            nickname: 'Bot Senna',
            position: { x: 1, y: 1 },
            velocity: { x: 0, y: 0 },
            isOffTrack: false,
          },
        ],
      },
      meta: { stuck: true, seat: 'bot-1' },
    },
  };

  it('marks the bot turn stuck so it can retry', () => {
    const ctx = parseRelayEnvelope(envelope, 'bot-1', 40, 24);
    expect(ctx?.isMyTurn).toBe(true);
    expect(ctx?.stuck).toBe(true);
  });

  it('ignores a stuck flag aimed at another seat', () => {
    const other = structuredClone(envelope);
    (other.payload as { meta: { seat: string } }).meta.seat = 'human';
    const ctx = parseRelayEnvelope(other, 'bot-1', 40, 24);
    expect(ctx?.stuck).toBe(false);
  });
});
