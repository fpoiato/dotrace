import { AsyncPipe } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { TRACKS, getTrackById } from '../../core/models/tracks';
import { GAME_MODES, GameMode, MIN_PLAYERS } from '../../core/models/ws-types';
import { GameEngineService } from '../../core/services/game-engine.service';
import { RoomService } from '../../core/services/room.service';
import { WebSocketService } from '../../core/services/websocket.service';
import { HowToPlayComponent } from '../../shared/how-to-play.component';
import { TrackPickerComponent } from '../../shared/track-picker.component';

@Component({
  selector: 'app-lobby',
  standalone: true,
  imports: [AsyncPipe, TranslateModule, HowToPlayComponent, TrackPickerComponent],
  templateUrl: './lobby.component.html',
})
export class LobbyComponent implements OnInit, OnDestroy {
  private readonly room = inject(RoomService);
  private readonly game = inject(GameEngineService);
  private readonly ws = inject(WebSocketService);
  private readonly router = inject(Router);

  readonly room$ = this.room.room$;
  readonly players$ = this.room.players$;
  readonly pending$ = this.room.pending$;
  readonly tracks = TRACKS;
  readonly minPlayers = MIN_PLAYERS;

  selectedTrackId = '';
  selectedLaps = 1;
  selectedGameMode: GameMode = 'TURNS';
  readonly lapOptions = [1, 2, 3];
  readonly gameModes = GAME_MODES;
  copied = false;
  showHowTo = false;
  private readonly subs: Subscription[] = [];

  ngOnInit(): void {
    if (!this.room.room) {
      void this.router.navigate(['/']);
      return;
    }
    this.game.init();
    this.game.ensureLobbyState();

    this.subs.push(
      this.room.listenForLobbyUpdates().subscribe(),
      // Follow the host into the race: any relayed state past LOBBY moves
      // everyone to the game screen.
      this.game.state$.subscribe((state) => {
        if (state?.trackId) this.selectedTrackId = state.trackId;
        if (state?.totalLaps) this.selectedLaps = state.totalLaps;
        if (state?.gameMode) this.selectedGameMode = state.gameMode;
        if (state && state.phase !== 'LOBBY') {
          void this.router.navigate(['/game']);
        }
      }),
      // A pending joiner rejected by the host goes back to the landing page.
      this.ws.onAction<{ message: string }>('JOIN_REJECTED').subscribe(() => {
        this.room.reset();
        this.ws.disconnect();
        void this.router.navigate(['/']);
      })
    );
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  trackName(trackId: string): string {
    return getTrackById(trackId)?.nameKey ?? '';
  }

  approve(id: string): void {
    this.room.approvePlayer(id);
  }

  reject(id: string): void {
    this.room.rejectPlayer(id);
  }

  selectTrack(trackId: string): void {
    this.selectedTrackId = trackId;
    this.game.selectTrack(trackId);
  }

  selectLaps(laps: number): void {
    this.selectedLaps = laps;
    this.game.selectLaps(laps);
  }

  selectGameMode(mode: GameMode): void {
    this.selectedGameMode = mode;
    this.game.selectGameMode(mode);
  }

  startRace(): void {
    this.game.startRace();
    void this.router.navigate(['/game']);
  }

  copyInvite(roomCode: string): void {
    void navigator.clipboard.writeText(this.room.getInviteUrl(roomCode));
    this.copied = true;
    setTimeout(() => (this.copied = false), 2000);
  }

  whatsApp(roomCode: string): void {
    window.open(this.room.getWhatsAppUrl(roomCode), '_blank');
  }
}
