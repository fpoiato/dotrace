import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import {
  GameState,
  RaceReplay,
  buildReplayFrames,
  replayStepRound,
} from '../../core/models/ws-types';
import { TrackCanvasComponent } from './track-canvas.component';

/** Base delay between replayed moves, in ms (divided by the playback speed). */
const BASE_STEP_MS = 650;
const SPEEDS = [1, 2, 4] as const;

/**
 * Post-race replay player. Rebuilds the board move-by-move from the recorded
 * replay log and drives the shared track canvas, with scrubbing, play/pause
 * and variable speed.
 */
@Component({
  selector: 'app-race-replay',
  standalone: true,
  imports: [TranslateModule, TrackCanvasComponent],
  template: `
    <div class="rounded-2xl bg-slate-800 p-4">
      <div class="mb-3 flex items-center justify-between">
        <h3 class="text-lg font-bold text-orange-400">{{ 'replay.title' | translate }}</h3>
        <button
          type="button"
          (click)="close.emit()"
          class="rounded-lg bg-slate-900 px-3 py-1 text-sm font-semibold text-slate-200 active:scale-95"
        >
          {{ 'replay.close' | translate }}
        </button>
      </div>

      @if (replayState) {
        <app-track-canvas [state]="replayState" />

        <div class="mt-3 flex items-center justify-between text-xs font-mono text-slate-300">
          <span class="rounded-full bg-slate-900 px-3 py-1">
            {{ 'game.round' | translate }} {{ round }}
          </span>
          <span class="text-slate-400">{{ step }} / {{ totalMoves }}</span>
        </div>

        <input
          type="range"
          class="mt-3 w-full accent-orange-500"
          min="0"
          [max]="totalMoves"
          step="1"
          [value]="step"
          [attr.aria-label]="'replay.scrub' | translate"
          (input)="onScrub($event)"
        />

        <div class="mt-3 flex items-center justify-center gap-2">
          <button
            type="button"
            (click)="restart()"
            [attr.aria-label]="'replay.restart' | translate"
            class="min-h-11 min-w-11 rounded-xl bg-slate-900 px-3 text-lg font-bold text-white active:scale-95"
          >
            ⏮
          </button>
          <button
            type="button"
            (click)="stepBack()"
            [disabled]="step === 0"
            [attr.aria-label]="'replay.stepBack' | translate"
            class="min-h-11 min-w-11 rounded-xl bg-slate-900 px-3 text-lg font-bold text-white disabled:opacity-30 active:scale-95"
          >
            ◀
          </button>
          <button
            type="button"
            (click)="togglePlay()"
            class="min-h-11 flex-1 rounded-xl bg-orange-500 px-4 text-base font-bold text-white active:scale-95"
          >
            @if (playing) {
              ⏸ {{ 'replay.pause' | translate }}
            } @else {
              ▶ {{ 'replay.play' | translate }}
            }
          </button>
          <button
            type="button"
            (click)="stepForward()"
            [disabled]="step >= totalMoves"
            [attr.aria-label]="'replay.stepForward' | translate"
            class="min-h-11 min-w-11 rounded-xl bg-slate-900 px-3 text-lg font-bold text-white disabled:opacity-30 active:scale-95"
          >
            ▶
          </button>
          <button
            type="button"
            (click)="cycleSpeed()"
            [attr.aria-label]="'replay.speed' | translate"
            class="min-h-11 min-w-11 rounded-xl bg-slate-900 px-3 text-sm font-bold text-white active:scale-95"
          >
            {{ speed }}×
          </button>
        </div>
      } @else {
        <p class="py-6 text-center text-sm text-slate-400">{{ 'replay.noData' | translate }}</p>
      }
    </div>
  `,
})
export class RaceReplayComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) replay: RaceReplay | null = null;
  @Output() close = new EventEmitter<void>();

  step = 0;
  speed: number = SPEEDS[0];
  playing = false;
  replayState: GameState | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;

  get totalMoves(): number {
    return this.replay?.moves.length ?? 0;
  }

  get round(): number {
    return this.replay ? replayStepRound(this.replay, this.step) : 1;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['replay']) {
      this.stop();
      this.step = 0;
      this.rebuild();
    }
  }

  ngOnDestroy(): void {
    this.stop();
  }

  togglePlay(): void {
    if (this.playing) {
      this.stop();
      return;
    }
    if (this.step >= this.totalMoves) this.step = 0;
    this.playing = true;
    this.schedule();
    this.rebuild();
  }

  restart(): void {
    this.stop();
    this.step = 0;
    this.rebuild();
  }

  stepForward(): void {
    this.stop();
    if (this.step < this.totalMoves) {
      this.step += 1;
      this.rebuild();
    }
  }

  stepBack(): void {
    this.stop();
    if (this.step > 0) {
      this.step -= 1;
      this.rebuild();
    }
  }

  cycleSpeed(): void {
    const idx = SPEEDS.indexOf(this.speed as (typeof SPEEDS)[number]);
    this.speed = SPEEDS[(idx + 1) % SPEEDS.length];
    if (this.playing) this.schedule();
  }

  onScrub(event: Event): void {
    this.stop();
    const value = Number((event.target as HTMLInputElement).value);
    this.step = Math.max(0, Math.min(value, this.totalMoves));
    this.rebuild();
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), BASE_STEP_MS / this.speed);
  }

  private tick(): void {
    if (this.step >= this.totalMoves) {
      this.stop();
      return;
    }
    this.step += 1;
    this.rebuild();
  }

  private stop(): void {
    this.playing = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Rebuild the synthetic GameState the shared canvas renders from. */
  private rebuild(): void {
    const replay = this.replay;
    if (!replay || replay.grid.length === 0) {
      this.replayState = null;
      return;
    }
    const frames = buildReplayFrames(replay, this.step);
    this.replayState = {
      phase: 'GAME_OVER',
      hostId: '',
      trackId: replay.trackId,
      totalLaps: replay.totalLaps,
      gameMode: replay.gameMode,
      turnOrder: [],
      currentTurnIndex: 0,
      round: this.round,
      diceRolls: {},
      podium: [],
      players: frames.map((f) => ({
        connectionId: f.connectionId,
        nickname: f.nickname,
        color: f.color,
        isHost: false,
        joinOrder: 0,
        status: 'approved',
        position: f.position,
        velocity: f.velocity,
        isOffTrack: f.offTrack,
        trail: f.trail,
        lap: f.lap,
      })),
    };
  }
}
