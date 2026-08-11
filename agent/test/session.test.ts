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

  it('waitForTurn times out instead of hanging forever', async () => {
    const { session, push } = setup();
    await session.join();
    push.emit({ action: 'PLAYER_APPROVED', payload: { connectionId: 'conn-ai' } });

    await expect(session.waitForTurn(50)).rejects.toThrow('Timed out');
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
