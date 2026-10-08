import { AsyncPipe } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { TRACKS, getTrackById } from '../../core/models/tracks';
import { LAP_OPTIONS, MAX_PLAYERS, Player } from '../../core/models/ws-types';
import { GameEngineService } from '../../core/services/game-engine.service';
import { RoomService } from '../../core/services/room.service';
import { WebSocketService } from '../../core/services/websocket.service';
import { HowToPlayComponent } from '../../shared/how-to-play.component';
import { TrackPickerComponent } from '../../shared/track-picker.component';

export type AiDifficulty = 'easy' | 'medium' | 'hard' | 'pro';

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
  private readonly translate = inject(TranslateService);

  readonly room$ = this.room.room$;
  readonly players$ = this.room.players$;
  readonly pending$ = this.room.pending$;
  readonly tracks = TRACKS;

  selectedTrackId = '';
  selectedLaps = 1;
  selectedDifficulty: AiDifficulty = 'pro';
  readonly lapOptions = LAP_OPTIONS;
  readonly difficulties: AiDifficulty[] = ['easy', 'medium', 'hard', 'pro'];
  readonly practiceHintKey = 'lobby.practiceHint';
  readonly maxPlayers = MAX_PLAYERS;
  showHowTo = false;
  aiSpawning = false;
  aiError = false;
  private readonly subs: Subscription[] = [];

  /** Names for heuristic bots (local planner). */
  private readonly botNames = ['Bot Alfa', 'Bot Turbo', 'Bot Apex', 'Bot Drift', 'Bot Nitro', 'Bot Pulse'];
  /** Names for Bedrock IA pilots. */
  private readonly iaNames = ['IA Nova', 'IA Micro', 'IA Vega', 'IA Comet', 'IA Bolt', 'IA Dash'];

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

  isPractice(playerCount: number): boolean {
    return playerCount <= 1;
  }

  startLabelKey(playerCount: number): string {
    return this.isPractice(playerCount) ? 'lobby.startPractice' : 'lobby.startRace';
  }

  difficultyLabelKey(level: AiDifficulty): string {
    return `lobby.difficulty.${level}`;
  }

  approve(id: string): void {
    this.room.approvePlayer(id);
  }

  canAddAi(players: Player[]): boolean {
    return players.length < this.maxPlayers;
  }

  selectDifficulty(level: AiDifficulty): void {
    this.selectedDifficulty = level;
  }

  async addBotPilot(players: Player[]): Promise<void> {
    await this.spawnPilot(players, 'laya', this.botNames);
  }

  async addIaPilot(players: Player[]): Promise<void> {
    await this.spawnPilot(players, 'bedrock', this.iaNames);
  }

  private async spawnPilot(
    players: Player[],
    brain: 'bedrock' | 'heuristic' | 'laya',
    names: string[]
  ): Promise<void> {
    if (this.aiSpawning) return;
    const suffix = this.translate.instant(this.difficultyLabelKey(this.selectedDifficulty));
    const taken = new Set(players.map((p) => p.nickname.toLowerCase()));
    const base = names.find(
      (n) => !taken.has(`${n} · ${suffix}`.toLowerCase()) && !taken.has(n.toLowerCase())
    );
    if (!base) return;
    const nickname = `${base} · ${suffix}`;

    this.aiSpawning = true;
    this.aiError = false;
    try {
      await this.room.spawnAiPlayer(nickname, brain, this.selectedDifficulty);
      this.aiSpawning = false;
    } catch (err) {
      console.warn('AI spawn failed', err);
      this.aiError = true;
      this.aiSpawning = false;
    }
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

  startRace(): void {
    this.game.startRace();
    void this.router.navigate(['/game']);
  }

  whatsApp(roomCode: string): void {
    window.open(this.room.getWhatsAppUrl(roomCode), '_blank');
  }
}
