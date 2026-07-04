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
  getTileAt,
  getValidMoves,
  landingPosition,
} from '../../core/models/ws-types';
import { GameEngineService } from '../../core/services/game-engine.service';
import { RoomService } from '../../core/services/room.service';
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
  private readonly room = inject(RoomService);
  private readonly ws = inject(WebSocketService);
  private readonly router = inject(Router);

  readonly state$ = this.game.state$;
  readonly roomCtx$ = this.room.room$;
  private readonly subs: Subscription[] = [];

  showCelebration = false;
  padOptions: PadOption[] = [];

  ngOnInit(): void {
    if (!this.room.room) {
      void this.router.navigate(['/']);
      return;
    }
    this.game.init();
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
    const isMyTurn =
      !!state &&
      state.phase === 'GAME_ROUND' &&
      state.turnOrder[state.currentTurnIndex] === myId &&
      me?.finishOrder === undefined;

    const valid = isMyTurn && me && track ? getValidMoves(me, track, state?.players) : [];

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

  backToMenu(): void {
    this.showCelebration = false;
    this.game.reset();
    this.room.reset();
    this.ws.disconnect();
    void this.router.navigate(['/']);
  }
}
