import type { GameState, Player } from '../../../shared/ws-types';
import { createLobbyPlayer, createInitialState } from '../../../shared/ws-types';
import {
  AI_SEAT_PREFIX,
  aiSeatId,
  aiTurnKey,
  isAiSeat,
  isHandoffResumeEvent,
  isHumanConnection,
  playerCanMove,
  roomHasHuman,
  shouldDispatchAiTurn,
  shouldInvokeLambdaOnSpawn,
  shouldRunAiWorker,
  slimGameStateForAi,
} from '../lambda/src/lib/ai-lifecycle';

function human(id = 'host-1', nick = 'Nando') {
  return { connectionId: id, nickname: nick, status: 'approved' as const };
}

describe('AI seat identity', () => {
  it('uses a distinct prefix from ghosts and markers', () => {
    const id = aiSeatId('ABCDE', 'Bot Alfa · Difícil');
    expect(isAiSeat(id)).toBe(true);
    expect(id.startsWith(AI_SEAT_PREFIX)).toBe(true);
    expect(id).toBe(aiSeatId('ABCDE', 'bot alfa · difícil'));
  });
});

describe('spawn-only-on-match-start', () => {
  it('never invokes Lambda when the host adds an AI in the lobby', () => {
    expect(shouldInvokeLambdaOnSpawn()).toBe(false);
  });

  it('dispatches a worker only during GAME_ROUND when a human is present and the AI can move', () => {
    expect(
      shouldDispatchAiTurn({ phase: 'LOBBY', stopped: false, hasHuman: true, canMove: true })
    ).toBe(false);
    expect(
      shouldDispatchAiTurn({ phase: 'GAME_ROUND', stopped: false, hasHuman: true, canMove: true })
    ).toBe(true);
    expect(
      shouldDispatchAiTurn({ phase: 'GAME_ROUND', stopped: false, hasHuman: false, canMove: true })
    ).toBe(false);
    expect(
      shouldDispatchAiTurn({ phase: 'GAME_OVER', stopped: false, hasHuman: true, canMove: true })
    ).toBe(false);
  });
});

describe('no handoff when room empty', () => {
  it('treats AI seats as non-human', () => {
    const seat = { connectionId: aiSeatId('ABCDE', 'Bot Alfa'), nickname: 'Bot Alfa · Médio' };
    expect(isHumanConnection(seat)).toBe(false);
    expect(isHumanConnection({ connectionId: 'abc123', nickname: 'Nando' })).toBe(true);
  });

  it('roomHasHuman is false when only AI seats remain', () => {
    expect(
      roomHasHuman([
        { connectionId: aiSeatId('ABCDE', 'Bot'), nickname: 'Bot Alfa', status: 'approved' },
      ])
    ).toBe(false);
    expect(roomHasHuman([human()])).toBe(true);
  });

  it('refuses the legacy 10-minute handoff/self-invoke payload', () => {
    expect(
      isHandoffResumeEvent({
        previousConnectionId: 'old-ws',
        handoffGeneration: 4,
      })
    ).toBe(true);
    expect(isHandoffResumeEvent({ state: { phase: 'GAME_ROUND' } })).toBe(false);
  });

  it('shouldRunAiWorker exits when no human is in the room', () => {
    const decision = shouldRunAiWorker({
      isHandoffResume: false,
      eventHasState: true,
      stopped: false,
      seatExists: true,
      hasHuman: false,
      phase: 'GAME_ROUND',
      canMove: true,
    });
    expect(decision).toEqual({ run: false, reason: 'no-human' });
  });

  it('shouldRunAiWorker refuses handoff events even if a human is present', () => {
    const decision = shouldRunAiWorker({
      isHandoffResume: true,
      eventHasState: false,
      stopped: false,
      seatExists: true,
      hasHuman: true,
      phase: 'GAME_ROUND',
      canMove: true,
    });
    expect(decision).toEqual({ run: false, reason: 'refuse-handoff' });
  });
});

describe('disconnect cancels AI', () => {
  it('stopped seats do not run', () => {
    const decision = shouldRunAiWorker({
      isHandoffResume: false,
      eventHasState: true,
      stopped: true,
      seatExists: true,
      hasHuman: true,
      phase: 'GAME_ROUND',
      canMove: true,
    });
    expect(decision).toEqual({ run: false, reason: 'stopped' });
  });

  it('missing seat is treated as stopped', () => {
    const decision = shouldRunAiWorker({
      isHandoffResume: false,
      eventHasState: true,
      stopped: true,
      seatExists: false,
      hasHuman: true,
      phase: 'GAME_ROUND',
      canMove: true,
    });
    expect(decision.run).toBe(false);
  });
});

describe('turn key and slim state', () => {
  function racingState(aiId: string, hostId: string): GameState {
    const host: Player = {
      ...createLobbyPlayer(hostId, 'Nando', true, 0, '#f00'),
      position: { x: 1, y: 1 },
      velocity: { x: 1, y: 0 },
    };
    const ai: Player = {
      ...createLobbyPlayer(aiId, 'Bot Alfa · Médio', false, 1, '#00f'),
      position: { x: 2, y: 1 },
      velocity: { x: 0, y: 0 },
    };
    const state = createInitialState([host, ai], hostId);
    state.phase = 'GAME_ROUND';
    state.turnOrder = [hostId, aiId];
    state.currentTurnIndex = 1;
    state.round = 3;
    state.replayLog = [{ seq: 1, round: 1, connectionId: hostId, position: host.position, velocity: host.velocity, isOffTrack: false, lap: 1 }];
    state.players[1].trail = [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ];
    return state;
  }

  it('builds a stable TURNS turn key that changes when the turn advances', () => {
    const aiId = aiSeatId('ABCDE', 'Bot Alfa · Médio');
    const state = racingState(aiId, 'host-1');
    const key = aiTurnKey(state, aiId);
    expect(key).toContain('turns:3:1:');
    state.currentTurnIndex = 0;
    expect(aiTurnKey(state, aiId)).not.toBe(key);
  });

  it('playerCanMove is true only for the current TURNS player', () => {
    const aiId = aiSeatId('ABCDE', 'Bot Alfa · Médio');
    const state = racingState(aiId, 'host-1');
    expect(playerCanMove(state, aiId)).toBe(true);
    expect(playerCanMove(state, 'host-1')).toBe(false);
  });

  it('strips replay log and long trails before invoke', () => {
    const aiId = aiSeatId('ABCDE', 'Bot Alfa · Médio');
    const slim = slimGameStateForAi(racingState(aiId, 'host-1'));
    expect(slim.replayLog).toEqual([]);
    expect(slim.players[1].trail).toHaveLength(3);
  });
});
