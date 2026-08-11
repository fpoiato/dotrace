import {
  GameState,
  RelayPayload,
  WsEnvelope,
  createLobbyPlayer,
  getValidMoves,
} from '../../shared/ws-types';
import { getTrackById } from '../../shared/tracks';
import { BotBrain } from '../src/bot-brain';
import { parseRelayEnvelope } from '../src/state-parser';

/**
 * The planner itself is covered in infra/cdk/test/bot-ai.test.ts; these tests
 * only check that the headless client feeds it the right thing and gets a move
 * the server will accept.
 */
describe('BotBrain', () => {
  const track = getTrackById('monza')!;

  function relay(): { envelope: WsEnvelope; state: GameState } {
    const player = createLobbyPlayer('bot', 'Bot', false, 1, '#3B82F6');
    player.position = { ...track.startLine[0] };
    player.velocity = { x: 0, y: 0 };
    player.passedCheckpoint = false;

    const state: GameState = {
      phase: 'GAME_ROUND',
      players: [player],
      hostId: 'host',
      trackId: track.id,
      turnOrder: ['bot'],
      currentTurnIndex: 0,
      round: 1,
      totalLaps: 1,
      gameMode: 'TURNS',
      diceRolls: {},
      podium: [],
      replayLog: [],
    };
    const payload: RelayPayload = { type: 'TURN_ADVANCED', state };
    return { envelope: { action: 'RELAY', payload }, state };
  }

  it('plays a move the host would accept', () => {
    const { envelope, state } = relay();
    const ctx = parseRelayEnvelope(envelope, 'bot')!;
    expect(ctx.isMyTurn).toBe(true);

    const vector = new BotBrain().computeNextMove(ctx, track)!;
    const valid = getValidMoves(state.players[0], track, state.players, state.round);
    expect(
      valid.some((m) => m.velocity.x === vector.x && m.velocity.y === vector.y)
    ).toBe(true);
  });

  it('pulls away from the grid rather than sitting still', () => {
    const { envelope } = relay();
    const ctx = parseRelayEnvelope(envelope, 'bot')!;
    const vector = new BotBrain().computeNextMove(ctx, track)!;
    expect(Math.abs(vector.x) + Math.abs(vector.y)).toBeGreaterThan(0);
  });

  it('ignores relays for a room it is not racing in', () => {
    const { envelope } = relay();
    expect(parseRelayEnvelope(envelope, 'someone-else')).toBeNull();
  });
});
