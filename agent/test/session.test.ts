import {
  GameState,
  WsEnvelope,
  createInitialState,
  createLobbyPlayer,
} from '../../shared/ws-types';
import { getTrackById } from '../../shared/tracks';
import { CommandClient, GameSession, PushChannel } from '../src/session';

const track = getTrackById('monza')!;

class FakePush implements PushChannel {
  private readonly handlers = new Set<(envelope: WsEnvelope) => void>();
  connectionId: string | null = 'conn-ai';
  disconnected = false;

  onMessage(handler: (envelope: WsEnvelope) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  onReconnect(): () => void {
    return () => undefined;
  }
  connect(): Promise<void> {
    return Promise.resolve();
  }
  getConnectionId(): string | null {
    return this.connectionId;
  }
  disconnect(): void {
    this.disconnected = true;
  }

  emit(envelope: WsEnvelope): void {
    for (const handler of this.handlers) handler(envelope);
  }
}

class FakeHttp implements CommandClient {
  readonly calls: { action: string; payload: unknown }[] = [];

  postAction<T = unknown>(action: string, payload: unknown): Promise<WsEnvelope<T>> {
    this.calls.push({ action, payload });
    return Promise.resolve({
      action: 'JOIN_PENDING',
      payload: { connectionId: 'conn-ai' },
    } as WsEnvelope<T>);
  }
}

function relayState(): GameState {
  const host = createLobbyPlayer('conn-host', 'Host', true, 1, '#EF4444');
  host.position = { x: 14, y: 28 };
  const me = createLobbyPlayer('conn-ai', 'AI Pilot', false, 2, '#3B82F6');
  me.position = { x: 12, y: 28 };

  const state = createInitialState([host, me], 'conn-host');
  state.phase = 'GAME_ROUND';
  state.trackId = track.id;
  state.turnOrder = ['conn-host', 'conn-ai'];
  state.currentTurnIndex = 0;
  state.round = 1;
  return state;
}

function setup() {
  const push = new FakePush();
  const http = new FakeHttp();
  const session = new GameSession(push, http, 'ABCDE', 'AI Pilot');
  return { push, http, session };
}

describe('GameSession', () => {
  it('joins and resolves approval when the host approves', async () => {
    const { push, session } = setup();
    await session.join();
    expect(session.getSnapshot().status).toBe('pending_approval');

    const approval = session.waitForApproval(5_000);
    push.emit({ action: 'PLAYER_APPROVED', payload: { connectionId: 'conn-ai' } });
    await expect(approval).resolves.toBeUndefined();
    expect(session.getSnapshot().status).toBe('approved');
  });

  it('rejects the approval promise when the host rejects', async () => {
    const { push, session } = setup();
    await session.join();

    const approval = session.waitForApproval(5_000);
    push.emit({ action: 'PLAYER_REJECTED', payload: {} });
    await expect(approval).rejects.toThrow('Rejected by host');
  });

  it('tracks relayed state and turn ownership', async () => {
    const { push, session } = setup();
    await session.join();
    push.emit({ action: 'PLAYER_APPROVED', payload: { connectionId: 'conn-ai' } });

    const state = relayState();
    push.emit({ action: 'RELAY', payload: { type: 'STATE_SYNC', state } });

    expect(session.getState()?.phase).toBe('GAME_ROUND');
    expect(session.getMyPlayer()?.nickname).toBe('AI Pilot');
    // Host moves first (currentTurnIndex = 0).
    expect(session.isMyTurn()).toBe(false);

    state.currentTurnIndex = 1;
    push.emit({ action: 'RELAY', payload: { type: 'TURN_ADVANCED', state } });
    expect(session.isMyTurn()).toBe(true);
  });

  it('waitForTurn resolves true on my turn and false on GAME_OVER', async () => {
    const { push, session } = setup();
    await session.join();
    push.emit({ action: 'PLAYER_APPROVED', payload: { connectionId: 'conn-ai' } });

    const myTurn = session.waitForTurn(5_000);
    const state = relayState();
    state.currentTurnIndex = 1;
    push.emit({ action: 'RELAY', payload: { type: 'TURN_ADVANCED', state } });
    await expect(myTurn).resolves.toBe(true);

    const over = { ...state, phase: 'GAME_OVER' as const };
    const done = session.waitForTurn(5_000);
    push.emit({ action: 'RELAY', payload: { type: 'GAME_OVER', state: over } });
    await expect(done).resolves.toBe(false);
  });

  it('settles a move when the sole pilot is handed the turn again', async () => {
    const { push, session } = setup();
    await session.join();
    push.emit({ action: 'PLAYER_APPROVED', payload: { connectionId: 'conn-ai' } });

    const state = relayState();
    state.turnOrder = ['conn-ai'];
    state.currentTurnIndex = 0;
    state.round = 2;
    const me = state.players.find((p) => p.connectionId === 'conn-ai')!;
    me.position = { x: 12, y: 28 };
    push.emit({ action: 'RELAY', payload: { type: 'TURN_ADVANCED', state } });
    expect(session.isMyTurn()).toBe(true);

    const settled = session.waitUntilMoveSettled({
      round: 2,
      x: 12,
      y: 28,
      replay: 0,
    });
    me.position = { x: 16, y: 28 };
    state.round = 3;
    push.emit({ action: 'RELAY', payload: { type: 'TURN_ADVANCED', state } });
    await expect(settled).resolves.toBeUndefined();
    expect(session.isMyTurn()).toBe(true);
  });

  it('waitForTurn times out instead of hanging forever', async () => {
    const { session, push } = setup();
    await session.join();
    push.emit({ action: 'PLAYER_APPROVED', payload: { connectionId: 'conn-ai' } });

    await expect(session.waitForTurn(50)).rejects.toThrow('Timed out');
  });

  it('waitUntilRacing waits through LOBBY then resolves when the race starts', async () => {
    const { push, session } = setup();
    await session.join();
    push.emit({ action: 'PLAYER_APPROVED', payload: { connectionId: 'conn-ai' } });

    const started = session.waitUntilRacing(5_000);
    const lobby = relayState();
    lobby.phase = 'LOBBY';
    push.emit({ action: 'RELAY', payload: { type: 'STATE_SYNC', state: lobby } });

    const racing = relayState();
    racing.phase = 'GAME_ROUND';
    push.emit({ action: 'RELAY', payload: { type: 'STATE_SYNC', state: racing } });
    await expect(started).resolves.toBe(true);
  });

  it('does not downgrade to pending after an earlier PLAYER_APPROVED (auto-approve race)', async () => {
    const { push, session } = setup();
    await session.join();
    expect(session.getSnapshot().status).toBe('pending_approval');

    push.emit({ action: 'PLAYER_APPROVED', payload: { connectionId: 'conn-ai' } });
    expect(session.getSnapshot().status).toBe('approved');

    // Late JOIN_PENDING (the pre-fix HTTP reply shape) must not undo approval.
    push.emit({
      action: 'JOIN_PENDING',
      payload: { connectionId: 'conn-ai', roomCode: 'ABCDE', nickname: 'AI Pilot' },
    });
    expect(session.getSnapshot().status).toBe('approved');
  });

  it('accepts PLAYER_APPROVED as the join HTTP reply (auto-approve path)', async () => {
    const push = new FakePush();
    const http = new FakeHttp();
    http.postAction = <T = unknown>() =>
      Promise.resolve({
        action: 'PLAYER_APPROVED',
        payload: {
          connectionId: 'conn-ai',
          nickname: 'AI Pilot',
          status: 'approved',
          players: [],
        },
      } as WsEnvelope<T>);

    const session = new GameSession(push, http, 'ABCDE', 'AI Pilot');
    await session.join();
    expect(session.getSnapshot().status).toBe('approved');
  });

  it('ignores approval broadcasts and rejections aimed at other players', async () => {
    const { push, session } = setup();
    await session.join();

    // Another player's approval must not flip our status or steal our id.
    push.emit({ action: 'PLAYER_APPROVED', payload: { connectionId: 'conn-other' } });
    expect(session.getSnapshot().status).toBe('pending_approval');
    expect(session.getSnapshot().connectionId).toBe('conn-ai');

    push.emit({ action: 'PLAYER_REJECTED', payload: { connectionId: 'conn-other' } });
    expect(session.getSnapshot().status).toBe('pending_approval');

    push.emit({ action: 'PLAYER_APPROVED', payload: { connectionId: 'conn-ai' } });
    expect(session.getSnapshot().status).toBe('approved');
  });

  it('waitUntilMoveSettled resolves after the turn advances', async () => {
    const { push, session } = setup();
    await session.join();
    push.emit({ action: 'PLAYER_APPROVED', payload: { connectionId: 'conn-ai' } });

    const state = relayState();
    state.currentTurnIndex = 1;
    push.emit({ action: 'RELAY', payload: { type: 'TURN_ADVANCED', state } });
    expect(session.isMyTurn()).toBe(true);
    const me = state.players.find((p) => p.connectionId === 'conn-ai')!;

    const done = session.waitUntilMoveSettled({
      round: state.round,
      x: me.position.x,
      y: me.position.y,
      replay: state.replayLog?.length ?? 0,
    });
    state.currentTurnIndex = 0;
    push.emit({ action: 'RELAY', payload: { type: 'TURN_ADVANCED', state } });
    await expect(done).resolves.toBeUndefined();
    expect(session.isMyTurn()).toBe(false);
  });

  it('rejoins with a previous connection id without falling back to JOIN_ROOM', async () => {
    const push = new FakePush();
    const http = new FakeHttp();
    http.postAction = <T = unknown>(action: string, payload: unknown) => {
      http.calls.push({ action, payload });
      if (action === 'REJOIN_ROOM') {
        return Promise.resolve({
          action: 'ROOM_REJOINED',
          payload: { connectionId: 'conn-ai-2', nickname: 'AI Pilot' },
        } as WsEnvelope<T>);
      }
      return Promise.resolve({
        action: 'JOIN_PENDING',
        payload: { connectionId: 'conn-ai' },
      } as WsEnvelope<T>);
    };

    const session = new GameSession(push, http, 'ABCDE', 'AI Pilot');
    await session.rejoinWithPrevious('conn-old');

    expect(http.calls.map((c) => c.action)).toEqual(['REJOIN_ROOM']);
    expect(http.calls[0]?.payload).toMatchObject({
      nickname: 'AI Pilot',
      roomCode: 'ABCDE',
      previousConnectionId: 'conn-old',
    });
    expect(session.getSnapshot().status).toBe('approved');
    expect(session.getSnapshot().connectionId).toBe('conn-ai-2');
  });

  it('submits moves via FORWARD_TO_HOST', async () => {
    const { push, http, session } = setup();
    await session.join();
    push.emit({ action: 'PLAYER_APPROVED', payload: { connectionId: 'conn-ai' } });

    await session.submitMove({ x: 1, y: 0 });
    const submit = http.calls.find((c) => c.action === 'FORWARD_TO_HOST');
    expect(submit).toBeDefined();
    expect(submit?.payload).toEqual({ action: 'SUBMIT_MOVE', vector: { x: 1, y: 0 } });
  });
});
