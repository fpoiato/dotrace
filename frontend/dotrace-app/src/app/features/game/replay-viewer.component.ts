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
  ReplayMove,
  buildReplayState,
} from '../../core/models/ws-types';
import { TrackCanvasComponent } from './track-canvas.component';

/** Milliseconds between replay steps at 1× speed. */
const BASE_STEP_MS = 700;
const SPEEDS = [1, 2, 4] as const;

/**
 * Post-match replay: plays the recorded moves back on the track canvas.
 * The canvas receives a synthetic GameState rebuilt for every step, so all
 * the pen-and-paper rendering (trails, cars, camera) is reused as-is.
 */
@Component({
  selector: 'app-replay-viewer',
  standalone: true,
  imports: [TranslateModule, TrackCanvasComponent],
  template: `
    <div class="mt-4 rounded-2xl bg-slate-800 p-3">
      <div class="mb-2 flex items-center justify-between">
        <h3 class="text-lg font-bold text-orange-400">🎬 {{ 'replay.title' | translate }}</h3>
        <button
          type="button"
          [attr.aria-label]="'common.close' | translate"
          (click)="close()"
          class="h-9 w-9 rounded-lg bg-slate-900 text-lg font-bold text-slate-300 active:bg-slate-700"
        >
          ✕
        </button>
      </div>

      @if (frameState) {
        <app-track-canvas [state]="frameState" />
      }

      <p class="mt-2 min-h-6 text-center text-sm text-slate-300">
        @if (step === 0) {
          {{ 'replay.startingGrid' | translate }}
        } @else if (currentMover) {
          <span
            class="mr-1 inline-block h-2.5 w-2.5 rounded-full"
            [style.background]="currentMover.color"
          ></span>
          <span class="font-semibold">{{ currentMover.nickname }}</span>
          @if (currentMove?.crashed) {
            <span class="ml-1 text-red-400">💥 {{ 'replay.crashed' | translate }}</span>
          } @else if (currentMove?.finished) {
            <span class="ml-1 text-yellow-300">🏁 {{ 'replay.finished' | translate }}</span>
          } @else if (currentMove?.offTrack) {
            <span class="ml-1 text-amber-400">{{ 'replay.offTrack' | translate }}</span>
          }
          <span class="ml-2 text-xs text-slate-500">
            {{ 'game.round' | translate }} {{ currentMove?.round }} · {{ 'game.lap' | translate }}
            {{ currentMove?.lap }}
          </span>
        }
      </p>

      <input
        type="range"
        min="0"
        [max]="totalSteps"
        [value]="step"
        (input)="scrub($event)"
        class="mt-1 w-full accent-orange-500"
        [attr.aria-label]="'replay.title' | translate"
      />
      <div class="mt-1 flex items-center justify-between text-xs text-slate-500">
        <span>{{ step }}/{{ totalSteps }}</span>
      </div>

      <div class="mt-2 flex items-center justify-center gap-2">
        <button
          type="button"
          [attr.aria-label]="'replay.restart' | translate"
          (click)="restart()"
          class="min-h-12 flex-1 rounded-xl bg-slate-900 text-xl font-bold text-white active:bg-slate-700"
        >
          ⏮
        </button>
        <button
          type="button"
          [attr.aria-label]="(playing ? 'replay.pause' : 'replay.play') | translate"
          (click)="togglePlay()"
          class="min-h-12 flex-[2] rounded-xl bg-orange-600 text-xl font-bold text-white active:bg-orange-500"
        >
          {{ playing ? '⏸' : '▶' }}
        </button>
        <button
          type="button"
          [attr.aria-label]="'replay.speed' | translate"
          (click)="cycleSpeed()"
          class="min-h-12 flex-1 rounded-xl bg-slate-900 text-base font-bold text-white active:bg-slate-700"
        >
          {{ speed }}×
        </button>
      </div>
    </div>
  `,
})
export class ReplayViewerComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) replay!: RaceReplay;
  @Output() closed = new EventEmitter<void>();

  step = 0;
  playing = false;
  speed: (typeof SPEEDS)[number] = SPEEDS[0];
  frameState: GameState | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;

  get totalSteps(): number {
    return this.replay?.moves.length ?? 0;
  }

  /** The move applied on the current step (undefined at the starting grid). */
  get currentMove(): ReplayMove | undefined {
    return this.step > 0 ? this.replay?.moves[this.step - 1] : undefined;
  }

  get currentMover(): { nickname: string; color: string } | undefined {
    const move = this.currentMove;
    return move ? this.replay?.grid[move.player] : undefined;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['replay'] && this.replay) {
      this.step = 0;
      this.renderStep();
      this.play();
    }
  }

  ngOnDestroy(): void {
    this.stopTimer();
  }

  close(): void {
    this.stopTimer();
    this.playing = false;
    this.closed.emit();
  }

  togglePlay(): void {
    if (this.playing) {
      this.pause();
    } else {
      if (this.step >= this.totalSteps) this.step = 0;
      this.play();
    }
  }

  restart(): void {
    this.step = 0;
    this.renderStep();
    this.play();
  }

  cycleSpeed(): void {
    const idx = SPEEDS.indexOf(this.speed);
    this.speed = SPEEDS[(idx + 1) % SPEEDS.length];
    if (this.playing) this.startTimer();
  }

  scrub(event: Event): void {
    this.pause();
    this.step = Number((event.target as HTMLInputElement).value);
    this.renderStep();
  }

  private play(): void {
    this.playing = true;
    this.startTimer();
  }

  private pause(): void {
    this.playing = false;
    this.stopTimer();
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => this.tick(), BASE_STEP_MS / this.speed);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (this.step >= this.totalSteps) {
      this.pause();
      return;
    }
    this.step += 1;
    this.renderStep();
  }

  private renderStep(): void {
    this.frameState = buildReplayState(this.replay, this.step);
  }
}
