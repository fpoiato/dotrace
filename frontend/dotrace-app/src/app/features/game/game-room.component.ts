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
  canPlayerMove,
  formatRaceTime,
  getTileAt,
  getValidMoves,
  isGearLimited,
  isGrassShortcut,
  landingPosition,
  remainingStopMs,
  segmentCrossesGrass,
  segmentCrossesRumble,
} from '../../core/models/ws-types';
import { GameEngineService } from '../../core/services/game-engine.service';
import { HapticService } from '../../core/services/haptic.service';
import { RoomService } from '../../core/services/room.service';
import { TelemetryService } from '../../core/services/telemetry.service';
import { WebSocketService } from '../../core/services/websocket.service';
import { LoadingSpinnerComponent } from '../../shared/loading-spinner.component';
import { LeaderboardComponent } from './leaderboard.component';
import { MiniMapComponent } from './mini-map.component';
import { ReplayViewerComponent } from './replay-viewer.component';
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
  imports: [AsyncPipe, TranslateModule, TrackCanvasComponent, MiniMapComponent, LoadingSpinnerComponent, LeaderboardComponent, ReplayViewerComponent],
  templateUrl: './game-room.component.html',
})
export class GameRoomComponent implements OnInit, OnDestroy {
  readonly game = inject(GameEngineService);
  readonly telemetry = inject(TelemetryService);
  private readonly haptic = inject(HapticService);
  private readonly room = inject(RoomService);
  private readonly ws = inject(WebSocketService);
  private readonly router = inject(Router);

  readonly state$ = this.game.state$;
  readonly roomCtx$ = this.room.room$;
  readonly formatRaceTime = formatRaceTime;
  private readonly subs: Subscription[] = [];

  showCelebration = false;
  showReplay = false;
  padOptions: PadOption[] = [];
  /** Seconds left on a timed grass penalty (drives the popup countdown). */
  penaltyCountdownSec = 0;
  /** Tick every 250ms while a timed stop penalty is active. */
  private stopPenaltyTimer: ReturnType<typeof setInterval> | null = null;

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
        this.updatePenaltyCountdown(state);
        this.syncStopPenaltyTimer(state);
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

    const valid = canMove && me && track ? getValidMoves(me, track, state?.players, state?.round ?? 1) : [];

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
            const landing = landingPosition(me.position, match.velocity);
            grass =
              getTileAt(track, landing.x, landing.y) === 'grass' ||
              getTileAt(track, landing.x, landing.y) === 'rumble' ||
              segmentCrossesGrass(track, me.position, landing);
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
        grass:
          getTileAt(track, landing.x, landing.y) === 'grass' ||
          getTileAt(track, landing.x, landing.y) === 'rumble' ||
          segmentCrossesGrass(track, me.position, landing),
      };
    }

    return options;
  }

  pad(option: PadOption): void {
    if (!option.enabled || !option.velocity) return;

    const state = this.game.state;
    const me = state ? this.myPlayer(state) : undefined;
    const track = state?.trackId ? getTrackById(state.trackId) : undefined;
    if (me && track) {
      const landing = landingPosition(me.position, option.velocity);
      if (isGrassShortcut(track, me.position, landing)) {
        this.haptic.grassHit();
      } else if (
        getTileAt(track, landing.x, landing.y) === 'rumble' ||
        segmentCrossesRumble(track, me.position, landing)
      ) {
        this.haptic.rumbleStrip();
      }
    }

    this.game.submitMove(option.velocity);
  }

  ngOnDestroy(): void {
    this.clearStopPenaltyTimer();
    this.subs.forEach((s) => s.unsubscribe());
  }

  currentPlayerName(): string {
    return this.game.currentPlayer()?.nickname ?? '…';
  }

  myPlayer(state: GameState): Player | undefined {
    const id = this.room.room?.connectionId;
    return state.players.find((p) => p.connectionId === id);
  }

  /** TURNS mode: gear-1 cap from a grass penalty (not just standing on grass). */
  hasGearPenalty(state: GameState, player: Player): boolean {
    return isGearLimited(player, state.round) && !player.isOffTrack;
  }

  /** Seconds left on a timed stop penalty (0 if none). */
  stopPenaltySec(player: Player): number {
    return Math.ceil(remainingStopMs(player) / 1000);
  }

  private updatePenaltyCountdown(state: GameState | null): void {
    if (!state || state.gameMode !== 'TIMED' || state.phase !== 'GAME_ROUND') {
      this.penaltyCountdownSec = 0;
      return;
    }
    const me = this.myPlayer(state);
    this.penaltyCountdownSec = me ? this.stopPenaltySec(me) : 0;
  }

  private syncStopPenaltyTimer(state: GameState | null): void {
    const me = state && this.room.room
      ? state.players.find((p) => p.connectionId === this.room.room!.connectionId)
      : undefined;
    const active = !!me && remainingStopMs(me) > 0;
    if (active && !this.stopPenaltyTimer) {
      this.stopPenaltyTimer = setInterval(() => {
        const s = this.game.state;
        const id = this.room.room?.connectionId;
        const p = s?.players.find((pl) => pl.connectionId === id);
        this.padOptions = this.buildPadOptions(s);
        this.updatePenaltyCountdown(s);
        if (!p || remainingStopMs(p) <= 0) {
          this.clearStopPenaltyTimer();
        }
      }, 250);
    } else if (!active) {
      this.clearStopPenaltyTimer();
    }
  }

  private clearStopPenaltyTimer(): void {
    if (this.stopPenaltyTimer) {
      clearInterval(this.stopPenaltyTimer);
      this.stopPenaltyTimer = null;
    }
    this.penaltyCountdownSec = 0;
  }

  openReplay(): void {
    this.showReplay = true;
  }

  closeReplay(): void {
    this.showReplay = false;
  }

  get isHost(): boolean {
    return this.game.isHost;
  }

  playAgain(): void {
    this.showCelebration = false;
    this.showReplay = false;
    this.game.returnToLobby();
  }

  backToMenu(): void {
    this.showCelebration = false;
    this.showReplay = false;
    this.game.reset();
    this.room.reset();
    this.ws.disconnect();
    void this.router.navigate(['/']);
  }
}
