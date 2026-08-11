#!/usr/bin/env node
/**
 * Agentive Client entry point — wires WebSocket push, HTTP commands, and BotBrain.
 *
 * Usage:
 *   WS_URL=wss://… API_URL=https://… ROOM_CODE=ABCDE NICKNAME=AgentBot npm run dev
 *   npm run dev -- ABCDE AgentBot
 */
import { getTrackById } from '../../shared/tracks';
import { GameState, SubmitMoveAction, WsEnvelope } from '../../shared/ws-types';
import { BotBrain } from './bot-brain';
import { loadConfig } from './config';
import { HttpClient } from './http-client';
import { extractConnectionId, parseRelayEnvelope } from './state-parser';
import { WsClient } from './ws-client';

/** Outbound move envelope the Dot Race server expects from non-host players. */
interface SubmitMoveOutbound {
  action: 'FORWARD_TO_HOST';
  roomCode: string;
  payload: SubmitMoveAction;
}

function buildMoveEnvelope(
  roomCode: string,
  acceleration: { dx: number; dy: number },
  currentVelocity: { x: number; y: number }
): SubmitMoveOutbound {
  // Server validates the new velocity vector, not the raw acceleration delta.
  const vector = {
    x: currentVelocity.x + acceleration.dx,
    y: currentVelocity.y + acceleration.dy,
  };

  return {
    action: 'FORWARD_TO_HOST',
    roomCode,
    payload: { action: 'SUBMIT_MOVE', vector },
  };
}

class AgentiveClient {
  private connectionId: string | null = null;
  private approved = false;
  private lastGameState: GameState | null = null;
  private moveInFlight = false;
  private readonly brain = new BotBrain();

  constructor(
    private readonly ws: WsClient,
    private readonly http: HttpClient,
    private readonly roomCode: string,
    private readonly nickname: string
  ) {}

  async start(): Promise<void> {
    this.ws.onMessage((envelope) => this.handleMessage(envelope));
    this.ws.onReconnect(() => {
      void this.rejoinRoom();
    });
    await this.ws.connect();
    await this.joinRoom();
  }

  private async joinRoom(): Promise<void> {
    const connectionId = this.ws.getConnectionId();
    if (!connectionId) {
      throw new Error('No connectionId after WebSocket HELLO');
    }
    console.log(`[JOIN] Room ${this.roomCode} as ${this.nickname}`);
    const response = await this.http.postAction(
      'JOIN_ROOM',
      { nickname: this.nickname, roomCode: this.roomCode },
      connectionId,
      this.roomCode
    );
    this.handleMessage(response);
  }

  async rejoinRoom(): Promise<void> {
    const connectionId = this.ws.getConnectionId();
    if (!connectionId) {
      await this.joinRoom();
      return;
    }
    if (!this.connectionId) {
      await this.joinRoom();
      return;
    }
    console.log(`[REJOIN] Room ${this.roomCode}`);
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
      this.ws.publishLocal(response);
      this.handleMessage(response);
    } catch (err) {
      console.warn('[REJOIN FAILED]', err instanceof Error ? err.message : err);
      await this.joinRoom();
    }
  }

  private handleMessage(envelope: WsEnvelope): void {
    const newId = extractConnectionId(envelope);
    if (newId) {
      this.connectionId = newId;
    }

    switch (envelope.action) {
      case 'JOIN_PENDING':
        console.log('[LOBBY] Waiting for host approval…');
        break;

      case 'PLAYER_APPROVED':
        this.approved = true;
        console.log('[LOBBY] Approved — ready to race');
        break;

      case 'PLAYER_REJECTED':
        console.error('[LOBBY] Rejected by host');
        break;

      case 'ROOM_REJOINED':
        this.approved = true;
        console.log('[LOBBY] Rejoined session');
        break;

      case 'ERROR': {
        const msg = (envelope.payload as { message?: string }).message ?? 'Unknown error';
        console.error('[ERROR]', msg);
        break;
      }

      case 'RELAY':
        this.handleRelay(envelope);
        break;

      default:
        break;
    }
  }

  private handleRelay(envelope: WsEnvelope): void {
    if (!this.connectionId || !this.approved) return;

    const trackDef = this.resolveTrack(envelope);
    if (!trackDef) return;

    const ctx = parseRelayEnvelope(
      envelope,
      this.connectionId,
      trackDef.width,
      trackDef.height
    );
    if (!ctx) return;

    this.lastGameState = ctx.gameState;

    if (!ctx.isMyTurn || this.moveInFlight) return;

    const acceleration = this.brain.computeNextMove(
      ctx.car,
      ctx.track,
      trackDef,
      ctx.gameState.players,
      ctx.gameState.round
    );
    const outbound = buildMoveEnvelope(this.roomCode, acceleration, ctx.car.velocity);
    const connectionId = this.ws.getConnectionId();
    if (!connectionId) return;

    console.log(
      `[MOVE] relay=${ctx.relayType} accel=(${acceleration.dx},${acceleration.dy}) ` +
        `→ velocity=(${outbound.payload.vector.x},${outbound.payload.vector.y})`
    );

    this.moveInFlight = true;
    void this.http
      .postAction(outbound.action, outbound.payload, connectionId, outbound.roomCode)
      .catch((err) => console.warn('[MOVE FAILED]', err instanceof Error ? err.message : err))
      .finally(() => {
        setTimeout(() => {
          this.moveInFlight = false;
        }, 500);
      });
  }

  private resolveTrack(envelope: WsEnvelope) {
    const payload = envelope.payload as { state?: GameState };
    const trackId = payload.state?.trackId;
    if (!trackId) return undefined;
    return getTrackById(trackId);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const ws = new WsClient(config.wsUrl);
  const http = new HttpClient(config.apiUrl);
  const client = new AgentiveClient(ws, http, config.roomCode, config.nickname);

  process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN]');
    ws.disconnect();
    process.exit(0);
  });

  ws.onMessage((envelope) => {
    if (envelope.action === 'HOST_CHANGED') {
      console.log('[HOST_CHANGED] Host promoted — session continues');
    }
  });

  try {
    await client.start();
  } catch (err) {
    console.error('[FATAL]', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
