import { AsyncPipe } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { getTrackById } from '../../core/models/tracks';
import {
  GameState,
  Player,
  Vector2D,
  buildReplayCars,
  canPlayerMove,
  formatRaceTime,
  getTileAt,
  getValidMoves,
  landingPosition,
} from '../../core/models/ws-types';
import { GameEngineService } from '../../core/services/game-engine.service';
import { RoomService } from '../../core/services/room.service';
import { TelemetryService } from '../../core/services/telemetry.service';
import { WebSocketService } from '../../core/services/websocket.service';
import { LoadingSpinnerComponent } from '../../shared/loading-spinner.component';
import { MiniMapComponent } from './mini-map.component';
import { TrackCanvasComponent } from './track-canvas.component';

interface PadOption {
  key: string;
  glyph: string;
  enabled: boolean;
  velocity: Vector2D | null;
  /** The move is legal but lands in the gravel. */
  grass: boolean;
}

const PAD_GLYPHS: Record<string, string> = {
  '-1,-1': '↖',
  '0,-1': '↑',
  '1,-1': '↗',
  '-1,0': '←',
  '0,0': '●',
  '1,0': '→',
  '-1,1': '↙',
  '0,1': '↓',
  '1,1': '↘',
};

@Component({
  selector: 'app-game-room',
  standalone: true,
  imports: [AsyncPipe, TranslateModule, TrackCanvasComponent, MiniMapComponent, LoadingSpinnerComponent],
  templateUrl: './game-room.component.html',
})
export class GameRoomComponent implements OnInit, OnDestroy {
  readonly game = inject(GameEngineService);
  readonly telemetry = inject(TelemetryService);
  private readonly room = inject(RoomService);
  private readonly ws = inject(WebSocketService);
  private readonly router = inject(Router);

  readonly state$ = this.game.state$;
  readonly roomCtx$ = this.room.room$;
  readonly formatRaceTime = formatRaceTime;
  private readonly subs: Subscription[] = [];

  showCelebration = false;
  padOptions: PadOption[] = [];

  // ------------------------------------------------------------ replay
  showReplay = false;
  replayPlaying = false;
  replaySpeed: 1 | 2 | 4 = 1;
  replayIndex = 0;
  /** First scrubbable frame: all cars placed on the grid. */
  replayMin = 0;
  replayTotal = 0;
  replayState: GameState | null = null;
  /** Frozen final state the replay is reconstructed from. */
  private replayBase: GameState | null = null;
  private replayTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly REPLAY_TICK_MS = 600;

  ngOnInit(): void {
    if (!this.room.room) {
      void this.router.navigate(['/']);
      return;
    }
    this.game.init();
    this.telemetry.init();
    this.game.ensureLobbyState();

    this.subs.push(
      this.room.listenForLobbyUpdates().subscribe(),
      this.game.state$.subscribe((state) => {
        this.padOptions = this.buildPadOptions(state);
        if (state?.phase === 'GAME_OVER') {
          this.showCelebration = true;
        }
        // Host-migration fallback can reset the game to the lobby phase;
        // follow it so nobody is stranded on the game screen.
        if (state?.phase === 'LOBBY') {
          void this.router.navigate(['/lobby']);
        }
      })
    );
  }

  /**
   * The 3×3 "gear shift" pad: each button adjusts velocity by ±1 on each
   * axis (center = coast). Buttons are enabled only for moves the host
   * would accept, and flagged when the landing square is gravel.
   */
  private buildPadOptions(state: GameState | null): PadOption[] {
    const options: PadOption[] = [];
    const myId = this.room.room?.connectionId;
    const track = state?.trackId ? getTrackById(state.trackId) : undefined;
    const me = state?.players.find((p) => p.connectionId === myId);
    const canMove =
      !!state && !!myId && canPlayerMove(state, myId) && me?.finishOrder === undefined;

    const valid = canMove && me && track ? getValidMoves(me, track, state?.players) : [];

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = `${dx},${dy}`;
        let velocity: Vector2D | null = null;
        let grass = false;
        if (me && track) {
          const v = { x: me.velocity.x + dx, y: me.velocity.y + dy };
          const match = valid.find((m) => m.velocity.x === v.x && m.velocity.y === v.y);
          if (match) {
            velocity = match.velocity;
            grass = getTileAt(track, match.landing.x, match.landing.y) === 'grass';
          }
        }
        options.push({ key, glyph: PAD_GLYPHS[key], enabled: velocity !== null, velocity, grass });
      }
    }

    // Boxed-in at speed: the only legal move is the emergency stop, which is
    // not reachable via ±1 — surface it on the center button.
    if (valid.length > 0 && options.every((o) => !o.enabled) && me && track) {
      const stop = valid[0];
      const centerIdx = options.findIndex((o) => o.key === '0,0');
      const landing = landingPosition(me.position, stop.velocity);
      options[centerIdx] = {
        key: '0,0',
        glyph: '■',
        enabled: true,
        velocity: stop.velocity,
        grass: getTileAt(track, landing.x, landing.y) === 'grass',
      };
    }

    return options;
  }

  pad(option: PadOption): void {
    if (!option.enabled || !option.velocity) return;
    this.game.submitMove(option.velocity);
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.stopReplayTimer();
  }

  /** There is a replay worth watching once at least one real move was made. */
  hasReplay(state: GameState): boolean {
    return (state.moveLog ?? []).some((m) => m.round > 0);
  }

  /** What the main canvas shows: the replay frame while replaying, else live state. */
  canvasState(state: GameState): GameState {
    return this.showReplay && this.replayState ? this.replayState : state;
  }

  startReplay(state: GameState): void {
    const log = state.moveLog ?? [];
    if (log.length === 0) return;
    this.replayBase = structuredClone(state);
    this.replayTotal = log.length;
    const firstMove = log.findIndex((m) => m.round > 0);
    this.replayMin = firstMove === -1 ? log.length : firstMove;
    this.replayIndex = this.replayMin;
    this.showReplay = true;
    this.renderReplayFrame();
    this.playReplay();
  }

  closeReplay(): void {
    this.stopReplayTimer();
    this.showReplay = false;
    this.replayState = null;
    this.replayBase = null;
  }

  toggleReplayPlay(): void {
    if (this.replayPlaying) {
      this.stopReplayTimer();
    } else {
      if (this.replayIndex >= this.replayTotal) {
        this.replayIndex = this.replayMin;
        this.renderReplayFrame();
      }
      this.playReplay();
    }
  }

  restartReplay(): void {
    this.replayIndex = this.replayMin;
    this.renderReplayFrame();
    this.playReplay();
  }

  cycleReplaySpeed(): void {
    this.replaySpeed = this.replaySpeed === 1 ? 2 : this.replaySpeed === 2 ? 4 : 1;
    if (this.replayPlaying) this.playReplay();
  }

  seekReplay(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.replayIndex = Math.min(this.replayTotal, Math.max(this.replayMin, value));
    this.renderReplayFrame();
  }

  /** Racing round of the move currently on screen. */
  replayRound(): number {
    const log = this.replayBase?.moveLog ?? [];
    return log[Math.min(log.length, this.replayIndex) - 1]?.round ?? 0;
  }

  private playReplay(): void {
    this.stopReplayTimer();
    this.replayPlaying = true;
    this.replayTimer = setInterval(() => {
      if (this.replayIndex >= this.replayTotal) {
        this.stopReplayTimer();
        return;
      }
      this.replayIndex++;
      this.renderReplayFrame();
    }, GameRoomComponent.REPLAY_TICK_MS / this.replaySpeed);
  }

  private stopReplayTimer(): void {
    if (this.replayTimer) {
      clearInterval(this.replayTimer);
      this.replayTimer = null;
    }
    this.replayPlaying = false;
  }

  /**
   * Rebuild the board as it looked after `replayIndex` moves and emit a new
   * state reference so the canvas re-renders.
   */
  private renderReplayFrame(): void {
    const base = this.replayBase;
    if (!base) return;
    const log = base.moveLog ?? [];
    const frame = structuredClone(base);
    frame.phase = 'GAME_OVER';
    const cars = new Map(
      buildReplayCars(log, this.replayIndex).map((c) => [c.playerId, c])
    );
    for (const player of frame.players) {
      const car = cars.get(player.connectionId);
      if (car) {
        player.position = car.position;
        player.velocity = car.velocity;
        player.trail = car.trail;
      } else {
        // Not on the board yet at this point of the replay: park the car at
        // its first known square with a clean sheet.
        const first = log.find((m) => m.playerId === player.connectionId);
        if (first) {
          player.position = { ...first.to };
          player.trail = [];
        }
        player.velocity = { x: 0, y: 0 };
      }
    }
    this.replayState = frame;
  }

  currentPlayerName(): string {
    return this.game.currentPlayer()?.nickname ?? '…';
  }

  myPlayer(state: GameState): Player | undefined {
    const id = this.room.room?.connectionId;
    return state.players.find((p) => p.connectionId === id);
  }

  finishTime(state: GameState, connectionId: string): string | null {
    const player = state.players.find((p) => p.connectionId === connectionId);
    if (!player?.finishedAt || !state.raceStartedAt) return null;
    return formatRaceTime(player.finishedAt - state.raceStartedAt);
  }

  backToMenu(): void {
    this.closeReplay();
    this.showCelebration = false;
    this.game.reset();
    this.room.reset();
    this.ws.disconnect();
    void this.router.navigate(['/']);
  }
}
