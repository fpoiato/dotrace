import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, Subject } from 'rxjs';
import { Player, WsEnvelope, createLobbyPlayer } from '../models/ws-types';
import { ApiService } from './api.service';
import { GameEngineService } from './game-engine.service';
import { RoomContext, RoomService } from './room.service';
import { SessionStorageService } from './session-storage.service';
import { WebSocketService } from './websocket.service';

/** In-memory WS stub: the engine only subscribes to messages$. */
class FakeWebSocketService {
  readonly messages$ = new Subject<WsEnvelope>();
  connectionId = 'host-1';
}

class FakeApiService {
  readonly relays: { type: string }[] = [];
  postAction(action: string, payload: { type?: string }): Promise<unknown> {
    if (action === 'RELAY') this.relays.push({ type: payload.type ?? '' });
    return Promise.resolve({ action: 'RELAY_ACK', payload: { ok: true } });
  }
}

class FakeRoomService {
  private readonly roomSubject = new BehaviorSubject<RoomContext | null>({
    roomCode: 'ABCDE',
    nickname: 'Host',
    isHost: true,
    connectionId: 'host-1',
  });
  private readonly playersSubject = new BehaviorSubject<Player[]>([
    createLobbyPlayer('host-1', 'Host', true, 0, '#EF4444'),
  ]);
  readonly room$ = this.roomSubject.asObservable();
  readonly players$ = this.playersSubject.asObservable();
  readonly pending$ = new BehaviorSubject<Player[]>([]).asObservable();

  get room(): RoomContext | null {
    return this.roomSubject.value;
  }
  get players(): Player[] {
    return this.playersSubject.value;
  }
}

describe('GameEngineService — bot drivers', () => {
  let engine: GameEngineService;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        GameEngineService,
        { provide: WebSocketService, useClass: FakeWebSocketService },
        { provide: ApiService, useClass: FakeApiService },
        { provide: RoomService, useClass: FakeRoomService },
        SessionStorageService,
      ],
    });
    engine = TestBed.inject(GameEngineService);
    engine.init();
  });

  afterEach(() => {
    engine.reset();
    engine.ngOnDestroy();
  });

  it('keeps bots out of the roster until the race starts', () => {
    engine.selectTrack('monza');
    engine.selectBotCount(2);

    expect(engine.state?.botCount).toBe(2);
    expect(engine.state?.players.filter((p) => p.isBot).length).toBe(0);
  });

  it('clamps bot count to the room capacity', () => {
    engine.selectTrack('monza');
    engine.selectBotCount(99);

    expect(engine.state?.botCount).toBe(11); // MAX_PLAYERS - 1 human
  });

  it('adds bots to the race and lets them take their turns', async () => {
    engine.selectTrack('monza');
    engine.selectBotCount(2);
    engine.startRace();

    const started = engine.state;
    expect(started?.players.length).toBe(3);
    expect(started?.players.filter((p) => p.isBot).map((p) => p.connectionId)).toEqual([
      'bot-1',
      'bot-2',
    ]);

    // TURNS mode: grid qualifying runs first (humans + bots roll dice).
    expect(started?.phase).toBe('GRID_ORDER');
    await new Promise((r) => setTimeout(r, 2600)); // gridOrderTimer
    expect(engine.state?.phase).toBe('GAME_ROUND');

    // Let the bot tick + move timers run until every bot has moved at least
    // once. Human turns may interleave; bots must never get stuck waiting.
    const movedBots = new Set<string>();
    for (let i = 0; i < 120 && movedBots.size < 2; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const state = engine.state;
      if (!state) break;
      for (const p of state.players) {
        if (p.isBot && (p.trail.length > 1 || p.velocity.x !== 0 || p.velocity.y !== 0)) {
          movedBots.add(p.connectionId);
        }
      }
      // If it is the human's turn, make any legal move so the race flows.
      if (engine.isMyTurn()) {
        const me = state?.players.find((p) => p.connectionId === 'host-1');
        if (me) engine.submitMove({ x: me.velocity.x, y: me.velocity.y });
      }
    }
    expect(movedBots.size).toBe(2);
  }, 30000);

  it('drives bots in TIMED mode too', async () => {
    engine.selectTrack('monza');
    engine.selectGameMode('TIMED');
    engine.selectBotCount(1);
    engine.startRace();
    expect(engine.state?.phase).toBe('GAME_ROUND'); // timed skips the dice

    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const bot = engine.state?.players.find((p) => p.isBot);
      if (bot && (bot.trail.length > 1 || bot.velocity.x !== 0 || bot.velocity.y !== 0)) return;
    }
    throw new Error('bot never moved in TIMED mode');
  }, 30000);

  it('excludes bots from the global leaderboard deltas', async () => {
    const { buildRaceStatDeltas } = await import('../models/ws-types');
    engine.selectTrack('monza');
    engine.selectBotCount(1);
    engine.startRace();
    const state = engine.state;
    expect(state).toBeTruthy();
    const deltas = buildRaceStatDeltas(state!);
    expect(deltas.length).toBe(1);
    expect(deltas[0].nickname).toBe('Host');
  });
});
