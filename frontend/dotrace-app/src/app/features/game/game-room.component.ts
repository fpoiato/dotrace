import { AsyncPipe } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { getTrackById } from '../../core/models/tracks';
import {
  GameState,
  LapTime,
  Player,
  Vector2D,
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
  elapsedMs = 0;

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
      this.telemetry.elapsedMs$.subscribe((elapsed) => {
        this.elapsedMs = elapsed;
      }),
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

  leaderboard(state: GameState): Player[] {
    return [...state.players].sort((a, b) => {
      if (a.finishOrder !== undefined && b.finishOrder !== undefined) {
        return a.finishOrder - b.finishOrder;
      }
      if (a.finishOrder !== undefined) return -1;
      if (b.finishOrder !== undefined) return 1;

      const lapDelta = this.completedLapCount(b) - this.completedLapCount(a);
      if (lapDelta !== 0) return lapDelta;

      const checkpointDelta = Number(!!b.passedCheckpoint) - Number(!!a.passedCheckpoint);
      if (checkpointDelta !== 0) return checkpointDelta;

      return a.joinOrder - b.joinOrder;
    });
  }

  rankLabel(player: Player, index: number): string {
    return `#${player.finishOrder ?? index + 1}`;
  }

  lapProgress(player: Player, state: GameState): string {
    const lap = player.finishOrder === undefined ? player.lap : state.totalLaps;
    return `${Math.min(lap, state.totalLaps)}/${state.totalLaps}`;
  }

  completedLapTimes(player: Player): LapTime[] {
    return player.lapTimes ?? [];
  }

  currentLapTime(state: GameState, player: Player): string {
    if (player.finishOrder !== undefined) return '—';
    const raceStartedAt = state.raceStartedAt;
    if (!raceStartedAt) return '—';
    const lapStartedAt = player.currentLapStartedAt ?? raceStartedAt;
    const now = raceStartedAt + this.elapsedMs;
    return formatRaceTime(Math.max(0, now - lapStartedAt));
  }

  lastLapTime(player: Player): string {
    const last = this.completedLapTimes(player).at(-1);
    return last ? formatRaceTime(last.elapsedMs) : '—';
  }

  bestLapTime(player: Player): string {
    const best = this.completedLapTimes(player).reduce<number | null>(
      (min, lap) => (min === null ? lap.elapsedMs : Math.min(min, lap.elapsedMs)),
      null
    );
    return best === null ? '—' : formatRaceTime(best);
  }

  totalRaceTime(state: GameState, player: Player): string {
    if (!state.raceStartedAt || !player.finishedAt) return '—';
    return formatRaceTime(player.finishedAt - state.raceStartedAt);
  }

  private completedLapCount(player: Player): number {
    return player.finishOrder !== undefined ? Number.MAX_SAFE_INTEGER : this.completedLapTimes(player).length;
  }

  backToMenu(): void {
    this.showCelebration = false;
    this.game.reset();
    this.room.reset();
    this.ws.disconnect();
    void this.router.navigate(['/']);
  }
}
