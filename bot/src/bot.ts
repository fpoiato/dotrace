import type { GameState, Player, Vector2D, WsEnvelope } from '../../shared/ws-types';
import { getValidMoves } from '../../shared/ws-types';
import { getTrackById } from '../../shared/tracks';
import { BotBrain } from './bot-brain.js';
import { loadConfig, type BotConfig } from './config.js';
import { Logger } from './logger.js';
import { buildBotView, parseRelayState } from './state-parser.js';
import { GameSocket } from './ws-client.js';

/**
 * The Agentive Client orchestrator.
 *
 * Glue only — it owns no game math and no socket details. It:
 *   1. joins the room and tracks the bot's own identity,
 *   2. turns inbound RELAY envelopes into a `BotView` (via the parser),
 *   3. asks the `BotBrain` for an acceleration when it is the bot's turn,
 *   4. converts that acceleration into the velocity the server expects and
 *      submits it (via the transport).
 */
class DotRaceBot {
  private readonly log: Logger;
  private readonly socket: GameSocket;
  private readonly brain: BotBrain;

  private myId: string | null = null;
  private approved = false;

  /** Signature of the turn we last acted on — guards against double-submits. */
  private actedSig: string | null = null;
  private moveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: BotConfig) {
    this.log = new Logger(config.logLevel);
    this.socket = new GameSocket(config.wsUrl, this.log);
    this.brain = new BotBrain(this.log);

    this.socket.onOpen(() => this.onOpen());
    this.socket.onReconnect(() => this.onReconnect());
    this.socket.onMessage((env) => this.onMessage(env));
  }

  start(): void {
    if (!this.config.roomCode) {
      this.log.error('[CONFIG]', 'ROOM_CODE is required — the bot joins an existing room.');
      process.exit(1);
    }
    this.log.info('[BOT]', `joining room ${this.config.roomCode} as "${this.config.nickname}"`);
    this.socket.connect();
  }

  stop(): void {
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.socket.close();
  }

  // --- Connection lifecycle ------------------------------------------------

  private onOpen(): void {
    this.socket.send('JOIN_ROOM', {
      nickname: this.config.nickname,
      roomCode: this.config.roomCode,
    });
  }

  private onReconnect(): void {
    // Fresh socket => fresh connectionId. Rejoin under our old identity so the
    // host can splice us back into the running race.
    this.log.info('[BOT]', 'socket recovered — rejoining room');
    this.socket.send('REJOIN_ROOM', {
      nickname: this.config.nickname,
      roomCode: this.config.roomCode,
      previousConnectionId: this.myId ?? undefined,
    });
  }

  // --- Inbound routing -----------------------------------------------------

  private onMessage(env: WsEnvelope): void {
    switch (env.action) {
      case 'JOIN_PENDING': {
        const p = env.payload as { connectionId?: string; pending?: boolean };
        // The joiner's own confirmation has no `pending` flag (the host copy does).
        if (p.pending) break;
        if (p.connectionId) this.myId = p.connectionId;
        this.log.info('[BOT]', `joined as ${this.myId} — waiting for host approval`);
        break;
      }

      case 'ROOM_REJOINED': {
        const p = env.payload as { connectionId?: string; isHost?: boolean };
        if (p.connectionId) this.myId = p.connectionId;
        this.approved = true;
        this.log.info('[BOT]', `rejoined as ${this.myId}`);
        if (p.isHost) this.log.warn('[BOT]', 'promoted to HOST — this bot only plays as a client.');
        break;
      }

      case 'PLAYER_APPROVED': {
        const p = env.payload as { connectionId?: string };
        if (p.connectionId && p.connectionId === this.myId) {
          this.approved = true;
          this.log.info('[BOT]', 'approved by host — ready to race');
        }
        break;
      }

      case 'PLAYER_REJOINED': {
        const p = env.payload as { oldConnectionId?: string; newConnectionId?: string };
        if (p.oldConnectionId && p.oldConnectionId === this.myId && p.newConnectionId) {
          this.myId = p.newConnectionId;
        }
        break;
      }

      case 'HOST_CHANGED': {
        const p = env.payload as { newHostId?: string };
        if (p.newHostId && p.newHostId === this.myId) {
          this.log.warn('[BOT]', 'became HOST on migration — cannot run the authoritative engine.');
        }
        break;
      }

      case 'JOIN_REJECTED':
      case 'ERROR': {
        const p = env.payload as { message?: string };
        this.log.error('[BOT]', p.message ?? env.action);
        break;
      }

      case 'RELAY': {
        const state = parseRelayState(env);
        if (state) this.onState(state);
        break;
      }

      default:
        break;
    }
  }

  // --- Turn handling -------------------------------------------------------

  private onState(state: GameState): void {
    if (!this.myId) return;

    const view = buildBotView(state, this.myId);
    if (!view) return;

    if (state.phase === 'GAME_OVER') {
      this.log.info('[BOT]', 'race over', summarizePodium(state));
      this.stop();
      return;
    }

    if (!view.isMyTurn) return;

    // De-dupe: a turn is uniquely identified by round + whose-turn + our own
    // pose. It stays constant until we move, so we act exactly once per turn.
    const c = view.car;
    const sig = `${state.round}:${state.currentTurnIndex}:${c.position.x},${c.position.y}:${c.velocity.x},${c.velocity.y}`;
    if (sig === this.actedSig) return;
    this.actedSig = sig;

    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = setTimeout(() => this.playTurn(state), this.config.moveDelayMs);
  }

  private playTurn(state: GameState): void {
    if (!this.myId) return;
    const view = buildBotView(state, this.myId);
    if (!view || !view.isMyTurn) return;

    const { car, track, opponents } = view;

    // 1. Ask the brain for an acceleration (dx, dy ∈ {-1, 0, 1}).
    const accel = this.brain.computeNextMove(
      {
        position: car.position,
        velocity: car.velocity,
        isOffTrack: car.isOffTrack,
        passedCheckpoint: car.passedCheckpoint ?? false,
        lap: car.lap,
      },
      { track, opponents }
    );

    // 2. Physics: the server's move is the NEW VELOCITY (position + velocity =
    //    landing), so fold the acceleration into the current velocity.
    let vector: Vector2D = { x: car.velocity.x + accel.dx, y: car.velocity.y + accel.dy };

    // 3. Safety net: guarantee a host-legal submission. If the brain's pick is
    //    somehow rejected by the shared validator, fall back to the closest
    //    legal velocity (the validator always offers an emergency stop).
    vector = this.ensureLegal(car, state, vector);

    this.log.info(
      '[MOVE]',
      `round ${state.round}`,
      `accel=(${accel.dx},${accel.dy})`,
      `velocity=(${vector.x},${vector.y})`,
      `from=(${car.position.x},${car.position.y})`
    );

    this.socket.send('FORWARD_TO_HOST', { action: 'SUBMIT_MOVE', vector }, this.config.roomCode);
  }

  /** Snap a proposed velocity to the nearest host-legal option. */
  private ensureLegal(car: Player, state: GameState, proposed: Vector2D): Vector2D {
    const track = getTrackById(state.trackId);
    if (!track) return proposed;
    const legal = getValidMoves(car, track, state.players);
    if (legal.some((m) => m.velocity.x === proposed.x && m.velocity.y === proposed.y)) {
      return proposed;
    }
    // Closest legal velocity to the brain's intent.
    let best = legal[0].velocity;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const m of legal) {
      const d = Math.hypot(m.velocity.x - proposed.x, m.velocity.y - proposed.y);
      if (d < bestDist) {
        bestDist = d;
        best = m.velocity;
      }
    }
    this.log.debug('[MOVE]', 'brain pick was illegal; snapped to nearest legal', best);
    return best;
  }
}

function summarizePodium(state: GameState): string {
  return state.podium.map((e) => `${e.position}. ${e.nickname}`).join(', ') || '(no finishers)';
}

// --- Entry point -----------------------------------------------------------

const config = loadConfig();
const bot = new DotRaceBot(config);

process.on('SIGINT', () => {
  bot.stop();
  process.exit(0);
});
process.on('SIGTERM', () => {
  bot.stop();
  process.exit(0);
});

bot.start();
