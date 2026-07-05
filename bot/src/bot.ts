/**
 * Entry point — headless agentive client for Dot Race (Vector Rally).
 *
 * Wiring only; each concern lives in its own module:
 *   socket-client.ts  WebSocket transport (connect / reconnect / JSON frames)
 *   state-store.ts    inbound parsing → typed GameState + turn detection
 *   brain.ts          BotBrain pathfinding (carState + trackState → {dx, dy})
 *
 * Usage:
 *   BOT_WS_URL=wss://<api-id>.execute-api.us-east-1.amazonaws.com/prod \
 *   BOT_ROOM_CODE=ABCDE BOT_NICKNAME=VectorBot npm start
 */
import { Vector2D } from '../../shared/ws-types';
import { BotBrain } from './brain';
import { BotConfig, loadConfig } from './config';
import { log, logError } from './logger';
import { GameSocket } from './socket-client';
import { GameStateStore, TurnContext } from './state-store';

export class VectorRallyBot {
  private readonly socket: GameSocket;
  private readonly store: GameStateStore;
  private readonly brain = new BotBrain();

  /** Signature of the car state we last submitted a move for (dedupe guard). */
  private lastSubmittedSig: string | null = null;
  private lastSubmittedVector: Vector2D | null = null;
  private moveTimer: NodeJS.Timeout | null = null;
  private resubmitTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: BotConfig) {
    this.socket = new GameSocket(config.wsUrl);
    this.store = new GameStateStore({
      onMyTurn: (ctx) => this.scheduleMove(ctx),
      onGameOver: (state) => {
        const me = state.players.find((p) => p.connectionId === this.store.me?.connectionId);
        log('GAME OVER', me?.finishOrder ? `finished P${me.finishOrder}` : 'race ended');
        this.clearTimers();
      },
      onFatal: (message) => {
        logError('FATAL', message);
        this.stop();
        process.exitCode = 1;
      },
    });

    this.socket.onMessage((envelope) => this.store.handleEnvelope(envelope));

    // Fresh socket → join; re-opened socket → rejoin with our previous
    // connectionId so the host maps us back onto our car.
    this.socket.onOpen((isReconnect) => {
      const me = this.store.me;
      if (isReconnect && me) {
        this.socket.send(
          'REJOIN_ROOM',
          { nickname: me.nickname, roomCode: me.roomCode, previousConnectionId: me.connectionId },
          me.roomCode
        );
      } else {
        this.socket.send('JOIN_ROOM', { nickname: config.nickname, roomCode: config.roomCode });
      }
    });
  }

  start(): void {
    log('BOT', `joining room ${this.config.roomCode} at ${this.config.wsUrl} as ${this.config.nickname}`);
    this.socket.connect();
  }

  stop(): void {
    this.clearTimers();
    this.socket.close();
  }

  /**
   * A snapshot says we may move. Debounce duplicates (the host relays state
   * on every event, not only on our turn) and add a small "thinking" delay so
   * the bot's moves are watchable by human players.
   */
  private scheduleMove(ctx: TurnContext): void {
    // The car state signature only changes once the host applied a move (ours
    // or, in TURNS mode, the turn moved on) — identical sig means our previous
    // submission is still in flight.
    const sig = this.carSignature(ctx);
    if (sig === this.lastSubmittedSig) {
      this.armResubmit(ctx, sig);
      return;
    }
    this.lastSubmittedSig = null;
    this.clearTimers();

    this.moveTimer = setTimeout(() => this.submitMove(ctx, sig), this.config.moveDelayMs);
  }

  /** Move execution (outbound): compute with the brain, serialize, send. */
  private submitMove(ctx: TurnContext, sig: string): void {
    const accel = this.brain.computeNextMove(ctx.me, ctx.track, ctx.opponents);
    // Server expects the absolute velocity vector, not the acceleration:
    // vector = currentVelocity + {dx, dy}.
    const vector = this.brain.toVelocity(ctx.me, accel);

    log(
      'MOVE',
      `accel=(${accel.dx},${accel.dy}) velocity=(${vector.x},${vector.y}) ` +
        `from=(${ctx.me.position.x},${ctx.me.position.y}) lap=${ctx.me.lap}`
    );

    // Non-host moves travel via the server's FORWARD_TO_HOST relay and are
    // validated by the host with the same shared rules the brain used.
    this.socket.send(
      'FORWARD_TO_HOST',
      { action: 'SUBMIT_MOVE', vector },
      this.store.me?.roomCode ?? this.config.roomCode
    );
    this.lastSubmittedSig = sig;
    this.lastSubmittedVector = vector;
    this.armResubmit(ctx, sig);
  }

  /** If the host never acked (state unchanged), resend the same vector once per interval. */
  private armResubmit(ctx: TurnContext, sig: string): void {
    if (this.resubmitTimer) clearTimeout(this.resubmitTimer);
    this.resubmitTimer = setTimeout(() => {
      if (this.lastSubmittedSig !== sig || !this.lastSubmittedVector) return;
      log('MOVE', 'no state change since last submit — resending');
      this.socket.send(
        'FORWARD_TO_HOST',
        { action: 'SUBMIT_MOVE', vector: this.lastSubmittedVector },
        this.store.me?.roomCode ?? this.config.roomCode
      );
      this.armResubmit(ctx, sig);
    }, this.config.resubmitAfterMs);
  }

  private carSignature(ctx: TurnContext): string {
    const { position, velocity, lap } = ctx.me;
    return [
      position.x, position.y,
      velocity.x, velocity.y,
      lap,
      ctx.state.round,
      ctx.state.currentTurnIndex,
    ].join('|');
  }

  private clearTimers(): void {
    if (this.moveTimer) clearTimeout(this.moveTimer);
    if (this.resubmitTimer) clearTimeout(this.resubmitTimer);
    this.moveTimer = null;
    this.resubmitTimer = null;
  }
}

// Run only when executed directly (`npm start`), not when imported by tests.
if (require.main === module) {
  const config = loadConfig();
  if (!config.roomCode) {
    logError('CONFIG', 'BOT_ROOM_CODE is required (5-letter room code of an open lobby)');
    process.exit(1);
  }

  const bot = new VectorRallyBot(config);
  bot.start();

  process.on('SIGINT', () => {
    log('BOT', 'shutting down');
    bot.stop();
    process.exit(0);
  });
}
