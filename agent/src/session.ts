/**
 * GameSession — a reusable "network player" for Dot Race.
 *
 * Owns the WebSocket push channel + HTTP command client, tracks the latest
 * relayed GameState, and exposes the player-protocol surface (join, wait for
 * approval, wait for turn, submit move) that both the autonomous agent loop
 * and the MCP server build on.
 */
import {
  ClientAction,
  GameState,
  Player,
  RelayPayload,
  SubmitMoveAction,
  Vector2D,
  WsEnvelope,
  canPlayerMove,
} from '../../shared/ws-types';
import { extractConnectionId } from '../../bot/src/state-parser';

/** Structural surface of bot/src/ws-client — injectable for tests. */
export interface PushChannel {
  onMessage(handler: (envelope: WsEnvelope) => void): () => void;
  onReconnect(handler: () => void): () => void;
  connect(): Promise<void>;
  getConnectionId(): string | null;
  disconnect(): void;
}

/** Structural surface of bot/src/http-client — injectable for tests. */
export interface CommandClient {
  postAction<T = unknown>(
    action: ClientAction,
    payload: unknown,
    connectionId: string,
    roomCode?: string
  ): Promise<WsEnvelope<T>>;
}

export type SessionStatus =
  | 'disconnected'
  | 'connecting'
  | 'pending_approval'
  | 'approved'
  | 'rejected';

export interface SessionSnapshot {
  status: SessionStatus;
  connectionId: string | null;
  roomCode: string;
  nickname: string;
  phase: GameState['phase'] | null;
  isMyTurn: boolean;
  gameOver: boolean;
}

export class GameSession {
  private connectionId: string | null = null;
  private status: SessionStatus = 'disconnected';
  private lastState: GameState | null = null;
  private readonly stateListeners = new Set<(state: GameState) => void>();

  constructor(
    private readonly ws: PushChannel,
    private readonly http: CommandClient,
    readonly roomCode: string,
    readonly nickname: string
  ) {
    this.ws.onMessage((envelope) => this.handleMessage(envelope));
    this.ws.onReconnect(() => {
      void this.rejoin();
    });
  }

  // ------------------------------------------------------------ lifecycle

  async join(): Promise<void> {
    this.status = 'connecting';
    await this.ws.connect();
    const connectionId = this.ws.getConnectionId();
    if (!connectionId) {
      throw new Error('No connectionId after WebSocket HELLO');
    }
    const response = await this.http.postAction(
      'JOIN_ROOM',
      { nickname: this.nickname, roomCode: this.roomCode },
      connectionId,
      this.roomCode
    );
    this.handleMessage(response);
  }

  async rejoin(): Promise<void> {
    const connectionId = this.ws.getConnectionId();
    if (!connectionId || !this.connectionId) {
      await this.join();
      return;
    }
    try {
      const response = await this.http.postAction(
        'REJOIN_ROOM',
        {
          nickname: this.nickname,
          roomCode: this.roomCode,
          previousConnectionId: this.connectionId,
        },
        connectionId,
        this.roomCode
      );
      this.handleMessage(response);
    } catch {
      await this.join();
    }
  }

  leave(): void {
    this.ws.disconnect();
    this.status = 'disconnected';
    this.connectionId = null;
  }

  // ------------------------------------------------------------- queries

  getSnapshot(): SessionSnapshot {
    return {
      status: this.status,
      connectionId: this.connectionId,
      roomCode: this.roomCode,
      nickname: this.nickname,
      phase: this.lastState?.phase ?? null,
      isMyTurn: this.isMyTurn(),
      gameOver: this.lastState?.phase === 'GAME_OVER',
    };
  }

  getState(): GameState | null {
    return this.lastState;
  }

  getMyPlayer(): Player | null {
    if (!this.lastState || !this.connectionId) return null;
    return (
      this.lastState.players.find((p) => p.connectionId === this.connectionId) ?? null
    );
  }

  isMyTurn(): boolean {
    if (!this.lastState || !this.connectionId) return false;
    if (this.lastState.phase !== 'GAME_ROUND') return false;
    return canPlayerMove(this.lastState, this.connectionId);
  }

  // -------------------------------------------------------------- waiting

  /** Resolves when the host approves this player (or rejects → throws). */
  waitForApproval(timeoutMs = 120_000): Promise<void> {
    if (this.status === 'approved') return Promise.resolve();
    if (this.status === 'rejected') {
      return Promise.reject(new Error('Rejected by host'));
    }
    return this.waitFor(
      () =>
        this.status === 'approved'
          ? true
          : this.status === 'rejected'
            ? new Error('Rejected by host')
            : false,
      timeoutMs,
      'approval'
    );
  }

  /**
   * Resolves true when it is this player's turn, false when the race ended.
   * Rejects on timeout so callers never hang forever.
   */
  waitForTurn(timeoutMs = 300_000): Promise<boolean> {
    return this.waitFor(
      () => {
        if (this.lastState?.phase === 'GAME_OVER') return true;
        return this.isMyTurn() ? true : false;
      },
      timeoutMs,
      'turn'
    ).then(() => this.lastState?.phase !== 'GAME_OVER');
  }

  /**
   * Block until the host has applied our move and advanced the turn (or the
   * race ended). Prevents the race loop from double-submitting while the
   * cached state still says isMyTurn.
   */
  waitUntilNotMyTurn(timeoutMs = 30_000): Promise<void> {
    return this.waitFor(
      () => {
        if (this.lastState?.phase === 'GAME_OVER') return true;
        return this.isMyTurn() ? false : true;
      },
      timeoutMs,
      'turn end'
    );
  }

  private waitFor(
    check: () => boolean | Error,
    timeoutMs: number,
    label: string
  ): Promise<void> {
    const initial = check();
    if (initial === true) return Promise.resolve();
    if (initial instanceof Error) return Promise.reject(initial);

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`));
      }, timeoutMs);

      const onUpdate = () => {
        const result = check();
        if (result === false) return;
        clearTimeout(timer);
        unsubscribe();
        if (result instanceof Error) reject(result);
        else resolve();
      };

      const unsubscribe = () => this.stateListeners.delete(onUpdate);
      this.stateListeners.add(onUpdate);
    });
  }

  // --------------------------------------------------------------- moves

  /** Submit an absolute velocity vector. Host performs final validation. */
  async submitMove(vector: Vector2D): Promise<void> {
    const connectionId = this.ws.getConnectionId();
    if (!connectionId) {
      throw new Error('Not connected');
    }
    const payload: SubmitMoveAction = { action: 'SUBMIT_MOVE', vector };
    await this.http.postAction('FORWARD_TO_HOST', payload, connectionId, this.roomCode);
  }

  // ------------------------------------------------------------ internals

  private handleMessage(envelope: WsEnvelope): void {
    const payloadId = extractConnectionId(envelope);

    switch (envelope.action) {
      case 'CONNECTED':
        // Socket-level identity — always ours.
        if (payloadId) this.connectionId = payloadId;
        break;

      case 'JOIN_PENDING': {
        // The broadcast variant (pending: true) notifies the host about some
        // OTHER joiner — only the inline reply to our own join is ours.
        const isHostNotification =
          (envelope.payload as { pending?: boolean })?.pending === true;
        if (!isHostNotification) {
          if (payloadId) this.connectionId = payloadId;
          // Never downgrade: auto-approve can deliver PLAYER_APPROVED over the
          // WebSocket before the HTTP JOIN_PENDING reply is processed. Flipping
          // back to pending would leave waitForApproval hanging forever.
          if (this.status !== 'approved') {
            this.status = 'pending_approval';
          }
        }
        break;
      }

      case 'PLAYER_APPROVED': {
        // Broadcast to the whole room — only flip status when it names us.
        // Match against the session id OR the live socket id (the HTTP
        // auto-approve reply can arrive before CONNECTED has been mirrored
        // into this.connectionId in some test / race setups).
        const mine = this.connectionId ?? this.ws.getConnectionId();
        if (payloadId && payloadId === mine) {
          this.connectionId = payloadId;
          this.status = 'approved';
        }
        break;
      }

      case 'ROOM_REJOINED':
        if (payloadId) this.connectionId = payloadId;
        this.status = 'approved';
        break;

      case 'PLAYER_REJECTED': {
        const rejectedId = (envelope.payload as { connectionId?: string })?.connectionId;
        if (!rejectedId || rejectedId === this.connectionId) {
          this.status = 'rejected';
        }
        break;
      }

      case 'JOIN_REJECTED':
        this.status = 'rejected';
        break;

      case 'RELAY': {
        const payload = envelope.payload as RelayPayload;
        if (payload?.state) {
          this.lastState = payload.state;
        }
        break;
      }
      default:
        break;
    }

    // Any inbound message may change status or state — wake up all waiters.
    for (const listener of this.stateListeners) {
      listener(this.lastState as GameState);
    }
  }
}
