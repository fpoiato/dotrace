import { TestBed } from '@angular/core/testing';
import { fakeAsync, tick } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { computeBotMove } from '../models/ai';
import { getTrackById } from '../models/tracks';
import {
  Player,
  RaceStatDelta,
  WsEnvelope,
  createLobbyPlayer,
} from '../models/ws-types';
import { ApiService } from './api.service';
import { GameEngineService } from './game-engine.service';
import { RoomContext, RoomService } from './room.service';
import { SessionStorageService } from './session-storage.service';
import { WebSocketService } from './websocket.service';

/**
 * Integration tests for virtual AI opponents in the host game engine:
 * roster management, automatic bot turns (TURNS and TIMED) and keeping bot
 * nicknames out of the global leaderboard submission.
 */
describe('GameEngineService — AI bots', () => {
  let engine: GameEngineService;
  let roomStub: { room: RoomContext | null; players: Player[] };
  let apiStub: { postAction: jasmine.Spy };
  let wsMessages: Subject<WsEnvelope>;

  const BOT_TURN_MAX_MS = 1600; // BOT_TURN_DELAY_MS + jitter

  beforeEach(() => {
    wsMessages = new Subject<WsEnvelope>();
    roomStub = {
      room: { roomCode: 'ABCDE', nickname: 'Ana', isHost: true, connectionId: 'host-1' },
      players: [createLobbyPlayer('host-1', 'Ana', true, 0, '#EF4444')],
    };
    apiStub = {
      postAction: jasmine
        .createSpy('postAction')
        .and.returnValue(Promise.resolve({ action: 'RELAY_ACK', payload: {} })),
    };
    TestBed.configureTestingModule({
      providers: [
        {
          provide: WebSocketService,
          useValue: { messages$: wsMessages.asObservable(), connectionId: 'host-1' },
        },
        { provide: ApiService, useValue: apiStub },
        { provide: RoomService, useValue: roomStub },
        { provide: SessionStorageService, useValue: { load: () => null, save: () => undefined } },
      ],
    });
    engine = TestBed.inject(GameEngineService);
    engine.init();
  });

  it('adds and removes bots in the lobby', () => {
    engine.ensureLobbyState();
    engine.addBot('EASY');
    engine.addBot('HARD');

    expect(engine.bots.length).toBe(2);
    const bots = engine.state!.players.filter((p) => p.isBot);
    expect(bots.length).toBe(2);
    expect(bots.map((b) => b.botDifficulty)).toEqual(['EASY', 'HARD']);
    expect(bots.every((b) => b.nickname.startsWith('Bot'))).toBe(true);
    // Peers are told about the expanded roster.
    expect(
      apiStub.postAction.calls.allArgs().some((a) => a[0] === 'RELAY')
    ).toBe(true);

    engine.removeBot(engine.bots[0].id);
    expect(engine.state!.players.filter((p) => p.isBot).length).toBe(1);
    engine.reset();
  });

  it('drives bot turns automatically until the TURNS race ends', fakeAsync(() => {
    engine.ensureLobbyState();
    engine.selectTrack('monza');
    engine.addBot('HARD');
    engine.startRace();
    tick(2600); // grid-order dice reveal
    expect(engine.state!.phase).toBe('GAME_ROUND');
    expect(engine.state!.players.length).toBe(2);

    const track = getTrackById('monza')!;
    let guard = 0;
    while (engine.state!.phase !== 'GAME_OVER' && guard++ < 400) {
      const state = engine.state!;
      const current = state.players.find(
        (p) => p.connectionId === state.turnOrder[state.currentTurnIndex]
      )!;
      if (current.isBot) {
        tick(BOT_TURN_MAX_MS);
      } else {
        // The "human" host plays a sensible move so the race progresses.
        const move = computeBotMove(current, state, track, 'MEDIUM', () => 0.5);
        engine.submitMove(move);
      }
      tick(0);
    }

    const final = engine.state!;
    expect(final.phase).toBe('GAME_OVER');
    expect(final.podium.length).toBe(2);
    expect(final.replayLog!.some((m) => m.connectionId.startsWith('bot-'))).toBe(true);

    // Global leaderboard submission must include the human but never bots.
    const statsCalls = apiStub.postAction.calls
      .allArgs()
      .filter((a) => a[0] === 'SUBMIT_RACE_STATS');
    expect(statsCalls.length).toBe(1);
    const stats = (statsCalls[0][1] as { stats: RaceStatDelta[] }).stats;
    expect(stats.some((s) => s.nickname === 'Ana')).toBe(true);
    expect(stats.every((s) => !s.nickname.startsWith('Bot'))).toBe(true);
    engine.reset();
  }));

  it('moves bots on an interval in TIMED mode', fakeAsync(() => {
    engine.ensureLobbyState();
    engine.selectTrack('monaco');
    engine.selectGameMode('TIMED');
    engine.addBot('MEDIUM');
    engine.startRace();
    // TIMED races skip grid qualifying entirely.
    expect(engine.state!.phase).toBe('GAME_ROUND');

    tick(2500);
    const bot = engine.state!.players.find((p) => p.isBot)!;
    expect(bot.trail.length).toBeGreaterThan(1);
    engine.reset();
  }));

  it('keeps bots racing after a play-again rematch', fakeAsync(() => {
    engine.ensureLobbyState();
    engine.selectTrack('monza');
    engine.addBot('EASY');
    engine.startRace();
    tick(2600);
    expect(engine.state!.phase).toBe('GAME_ROUND');

    // Simulate race end, then host returns everyone (human + bot) to lobby.
    engine.state!.phase = 'GAME_OVER';
    tick(BOT_TURN_MAX_MS);
    engine.returnToLobby();

    const lobby = engine.state!;
    expect(lobby.phase).toBe('LOBBY');
    expect(lobby.players.filter((p) => p.isBot).length).toBe(1);
    expect(engine.bots.length).toBe(1);
    engine.reset();
  }));
});
