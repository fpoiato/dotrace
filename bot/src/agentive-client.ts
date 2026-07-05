import WebSocket from 'ws';
import { BotBrain } from './bot-brain.ts';
import { parseEnvelope, parseTurnState } from './state-parser.ts';
import type { BotConfig, MoveDecision, RoomContext, TurnState } from './types.ts';

export class AgentiveClient {
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly submittedTurnKeys = new Set<string>();
  private readonly room: RoomContext;

  constructor(
    private readonly config: BotConfig,
    private readonly brain = new BotBrain()
  ) {
    this.room = {
      roomCode: config.roomCode,
      nickname: config.nickname,
      isHost: false,
      approved: false,
    };
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    this.socket = new WebSocket(this.config.url);
    this.socket.on('open', () => this.handleOpen());
    this.socket.on('message', (data) => this.handleMessage(data.toString()));
    this.socket.on('close', (code, reason) => this.handleClose(code, reason.toString()));
    this.socket.on('error', (err) => console.error('[ERROR]', err.message));
  }

  private handleOpen(): void {
    console.log(`[CONNECTED] ${this.config.url}`);
    this.reconnectAttempts = 0;
    this.sendHandshake();
  }

  private handleClose(code: number, reason: string): void {
    console.log(`[DISCONNECTED] code=${code}${reason ? ` reason=${reason}` : ''}`);
    this.socket = null;
    if (!this.stopped) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const delay = Math.min(
      this.config.reconnectMinMs * 2 ** this.reconnectAttempts,
      this.config.reconnectMaxMs
    );
    this.reconnectAttempts++;
    console.log(`[RECONNECTING] attempt=${this.reconnectAttempts} delayMs=${delay}`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private sendHandshake(): void {
    if (this.room.roomCode && this.room.connectionId) {
      this.send('REJOIN_ROOM', {
        nickname: this.room.nickname,
        roomCode: this.room.roomCode,
        previousConnectionId: this.room.connectionId,
      });
      return;
    }

    if (this.config.createRoom) {
      this.send('CREATE_ROOM', { nickname: this.room.nickname });
      return;
    }

    if (this.room.roomCode) {
      this.send('JOIN_ROOM', {
        nickname: this.room.nickname,
        roomCode: this.room.roomCode,
      });
      return;
    }

    console.log('[CONNECTED] passive mode: no room code supplied, waiting for turn messages');
  }

  private handleMessage(raw: string): void {
    const envelope = parseEnvelope(raw);
    if (!envelope) {
      console.warn('[MESSAGE RECEIVED] invalid JSON');
      return;
    }

    const message = envelope as Record<string, unknown>;
    const label =
      typeof message.action === 'string'
        ? message.action
        : typeof message.type === 'string'
          ? message.type
          : 'UNKNOWN';
    console.log(`[MESSAGE RECEIVED] ${label}`);

    this.applyLifecycleMessage(message);

    const turnState = parseTurnState(envelope, this.room.connectionId);
    if (!turnState) {
      return;
    }

    const turnKey = this.turnKey(turnState);
    if (this.submittedTurnKeys.has(turnKey)) {
      return;
    }
    this.submittedTurnKeys.add(turnKey);

    const players = turnState.protocol === 'dotrace' ? turnState.gameState.players : [];
    const decision = this.brain.computeNextDecision(turnState.car, turnState.track, players);
    this.sendMove(turnState, decision);
  }

  private applyLifecycleMessage(envelope: Record<string, unknown>): void {
    const action = envelope.action;
    const payload = isObject(envelope.payload) ? envelope.payload : {};

    switch (action) {
      case 'ROOM_CREATED':
      case 'JOIN_PENDING':
      case 'ROOM_REJOINED': {
        this.captureConnection(payload);
        if (typeof payload.roomCode === 'string') {
          this.room.roomCode = payload.roomCode;
        }
        if (typeof payload.isHost === 'boolean') {
          this.room.isHost = payload.isHost;
        }
        if (action === 'ROOM_CREATED') {
          this.room.approved = true;
          console.log(`[ROOM] created ${this.room.roomCode}`);
          console.warn('[ROOM] bot is host; start the race from a browser client or join an existing room');
        }
        if (action === 'JOIN_PENDING') {
          console.log(`[ROOM] joined ${this.room.roomCode}; waiting for host approval`);
        }
        if (action === 'ROOM_REJOINED') {
          this.room.approved = true;
          console.log(`[ROOM] rejoined ${this.room.roomCode}`);
        }
        break;
      }
      case 'PLAYER_APPROVED': {
        const approvedId =
          typeof payload.connectionId === 'string' ? payload.connectionId : undefined;
        if (approvedId === this.room.connectionId || this.payloadIncludesSelf(payload)) {
          this.room.approved = true;
          console.log('[ROOM] approved by host');
        }
        break;
      }
      case 'PLAYER_REJOINED': {
        if (
          typeof payload.oldConnectionId === 'string' &&
          typeof payload.newConnectionId === 'string' &&
          payload.oldConnectionId === this.room.connectionId
        ) {
          this.room.previousConnectionId = payload.oldConnectionId;
          this.room.connectionId = payload.newConnectionId;
          console.log('[ROOM] connection id refreshed after rejoin');
        }
        break;
      }
      case 'HOST_CHANGED': {
        if (typeof payload.newHostId === 'string') {
          this.room.isHost = payload.newHostId === this.room.connectionId;
          if (this.room.isHost) {
            console.warn('[ROOM] bot was promoted to host; host-side game engine is not implemented');
          }
        }
        break;
      }
      case 'ERROR': {
        const message = typeof payload.message === 'string' ? payload.message : 'Unknown error';
        console.error(`[ERROR] server: ${message}`);
        break;
      }
    }
  }

  private captureConnection(payload: Record<string, unknown>): void {
    if (typeof payload.connectionId !== 'string') {
      return;
    }
    if (this.room.connectionId && this.room.connectionId !== payload.connectionId) {
      this.room.previousConnectionId = this.room.connectionId;
    }
    this.room.connectionId = payload.connectionId;
  }

  private payloadIncludesSelf(payload: Record<string, unknown>): boolean {
    if (!this.room.connectionId || !Array.isArray(payload.players)) {
      return false;
    }
    return payload.players.some(
      (player) => isObject(player) && player.connectionId === this.room.connectionId
    );
  }

  private sendMove(turnState: TurnState, decision: MoveDecision): void {
    if (turnState.protocol === 'generic') {
      this.sendEnvelope({
        action: 'MOVE',
        payload: decision.acceleration,
      });
      this.logMove(decision);
      return;
    }

    if (this.room.isHost) {
      console.warn('[MOVE SKIPPED] bot is host; outbound host move execution is not supported');
      return;
    }

    this.send(
      'FORWARD_TO_HOST',
      {
        action: 'SUBMIT_MOVE',
        vector: decision.velocity,
      },
      this.room.roomCode ?? turnState.roomCode
    );
    this.logMove(decision);
  }

  private logMove(decision: MoveDecision): void {
    console.log(
      `[MOVE SENT] acceleration=(${decision.acceleration.dx},${decision.acceleration.dy}) ` +
        `velocity=(${decision.velocity.x},${decision.velocity.y}) ` +
        `landing=(${decision.landing.x},${decision.landing.y}) reason=${decision.reason}`
    );
  }

  private send(action: string, payload: unknown, roomCode = this.room.roomCode): void {
    this.sendEnvelope({ action, payload, roomCode });
  }

  private sendEnvelope(envelope: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.warn('[SEND SKIPPED] WebSocket not connected');
      return;
    }
    this.socket.send(JSON.stringify(envelope));
  }

  private turnKey(turnState: TurnState): string {
    const { car } = turnState;
    if (turnState.protocol === 'generic') {
      return `generic:${car.position.x},${car.position.y}:${car.velocity.x},${car.velocity.y}`;
    }

    return [
      'dotrace',
      turnState.gameState.round,
      turnState.gameState.currentTurnIndex,
      car.id,
      car.position.x,
      car.position.y,
      car.velocity.x,
      car.velocity.y,
      car.passedCheckpoint === true ? 'checkpoint' : 'pre-checkpoint',
    ].join(':');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
