import { AsyncPipe } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { GameState, Player } from '../../core/models/ws-types';
import { GameEngineService } from '../../core/services/game-engine.service';
import { RoomService } from '../../core/services/room.service';
import { WebSocketService } from '../../core/services/websocket.service';
import { LoadingSpinnerComponent } from '../../shared/loading-spinner.component';
import { TrackCanvasComponent } from './track-canvas.component';

@Component({
  selector: 'app-game-room',
  standalone: true,
  imports: [AsyncPipe, TranslateModule, TrackCanvasComponent, LoadingSpinnerComponent],
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
        if (state?.phase === 'GAME_OVER') {
          this.showCelebration = true;
        }
        // Host-migration fallback can reset the game to the lobby phase;
        // follow it so nobody is stranded on the game screen.
        if (state?.phase === 'LOBBY') {
          this.room.setScreen('lobby');
          void this.router.navigate(['/lobby']);
        }
      })
    );
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
