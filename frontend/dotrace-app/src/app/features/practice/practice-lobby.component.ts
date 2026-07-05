import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { TRACKS, getTrackById } from '../../core/models/tracks';
import { GAME_MODES, GameMode } from '../../core/models/ws-types';
import { GameEngineService } from '../../core/services/game-engine.service';
import { SessionStorageService } from '../../core/services/session-storage.service';
import { HowToPlayComponent } from '../../shared/how-to-play.component';

@Component({
  selector: 'app-practice-lobby',
  standalone: true,
  imports: [TranslateModule, HowToPlayComponent],
  templateUrl: './practice-lobby.component.html',
})
export class PracticeLobbyComponent implements OnInit, OnDestroy {
  private readonly game = inject(GameEngineService);
  private readonly session = inject(SessionStorageService);
  private readonly router = inject(Router);

  readonly tracks = TRACKS;
  readonly lapOptions = [1, 2, 3];
  readonly gameModes = GAME_MODES;

  selectedTrackId = '';
  selectedLaps = 1;
  selectedGameMode: GameMode = 'TURNS';
  showHowTo = false;

  private readonly subs: Subscription[] = [];

  ngOnInit(): void {
    const saved = this.session.load();
    if (!saved?.nickname || saved.sessionKind !== 'practice') {
      void this.router.navigate(['/']);
      return;
    }

    this.game.enterPracticeLobby(saved.nickname);

    const state = this.game.state;
    if (state?.trackId) this.selectedTrackId = state.trackId;
    if (state?.totalLaps) this.selectedLaps = state.totalLaps;
    if (state?.gameMode) this.selectedGameMode = state.gameMode;

    this.subs.push(
      this.game.state$.subscribe((state) => {
        if (state?.trackId) this.selectedTrackId = state.trackId;
        if (state?.totalLaps) this.selectedLaps = state.totalLaps;
        if (state?.gameMode) this.selectedGameMode = state.gameMode;
        if (state && state.phase !== 'LOBBY') {
          void this.router.navigate(['/game']);
        }
      })
    );
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  trackName(trackId: string): string {
    return getTrackById(trackId)?.nameKey ?? '';
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

  backToMenu(): void {
    this.game.reset();
    this.session.save({ sessionKind: 'multiplayer' });
    void this.router.navigate(['/']);
  }
}
