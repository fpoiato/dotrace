import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import {
  GameState,
  ReplayMove,
  buildReplayState,
} from '../../core/models/ws-types';
import { TrackCanvasComponent } from './track-canvas.component';

@Component({
  selector: 'app-race-replay',
  standalone: true,
  imports: [TranslateModule, TrackCanvasComponent],
  template: `
    <div class="rounded-2xl bg-slate-800 p-4">
      <div class="mb-3 flex items-center justify-between gap-2">
        <h3 class="text-lg font-bold text-white">{{ 'game.replay' | translate }}</h3>
        <button
          type="button"
          (click)="close.emit()"
          class="rounded-lg bg-slate-700 px-3 py-1.5 text-sm font-medium text-slate-200"
        >
          {{ 'game.replayClose' | translate }}
        </button>
      </div>

      @if (displayState) {
        <app-track-canvas [state]="displayState" />
      }

      <div class="mt-4 space-y-3">
        @if (currentMove; as move) {
          <p class="text-center text-sm text-slate-300">
            <span class="inline-block h-2.5 w-2.5 rounded-full align-middle" [style.background]="move.color"></span>
            <span class="ml-2 font-medium">{{ move.nickname }}</span>
            @if (state.gameMode !== 'TIMED') {
              <span class="text-slate-500"> · {{ 'game.round' | translate }} {{ move.round }}</span>
            }
            <span class="text-slate-500">
              · {{ 'game.replayMove' | translate: { current: move.seq, total: totalMoves } }}
            </span>
            @if (move.outcome === 'collision') {
              <span class="text-red-400"> · {{ 'game.replayCollision' | translate }}</span>
            } @else if (move.outcome === 'off_track') {
              <span class="text-amber-400"> · {{ 'game.replayOffTrack' | translate }}</span>
            }
            @if (move.finishOrder !== undefined) {
              <span class="text-green-400">
                · {{ 'game.finished' | translate: { pos: move.finishOrder } }}
              </span>
            }
          </p>
        } @else {
          <p class="text-center text-sm text-slate-400">{{ 'game.replayStart' | translate }}</p>
        }

        <input
          type="range"
          class="w-full accent-orange-500"
          [min]="-1"
          [max]="totalMoves - 1"
          [value]="step"
          (input)="onScrub($event)"
        />

        <div class="flex items-center justify-center gap-2">
          <button
            type="button"
            (click)="stepToStart()"
            [disabled]="step < 0"
            class="min-h-11 rounded-xl bg-slate-700 px-3 text-sm font-bold text-white disabled:opacity-30"
          >
            ⏮
          </button>
          <button
            type="button"
            (click)="stepBack()"
            [disabled]="step < 0"
            class="min-h-11 rounded-xl bg-slate-700 px-4 text-sm font-bold text-white disabled:opacity-30"
          >
            ◀
          </button>
          <button
            type="button"
            (click)="togglePlay()"
            [disabled]="totalMoves === 0"
            class="min-h-11 min-w-[5.5rem] rounded-xl bg-orange-600 px-4 text-sm font-bold text-white disabled:opacity-30"
          >
            {{ playing ? ('game.replayPause' | translate) : ('game.replayPlay' | translate) }}
          </button>
          <button
            type="button"
            (click)="stepForward()"
            [disabled]="step >= totalMoves - 1"
            class="min-h-11 rounded-xl bg-slate-700 px-4 text-sm font-bold text-white disabled:opacity-30"
          >
            ▶
          </button>
          <button
            type="button"
            (click)="stepToEnd()"
            [disabled]="step >= totalMoves - 1"
            class="min-h-11 rounded-xl bg-slate-700 px-3 text-sm font-bold text-white disabled:opacity-30"
          >
            ⏭
          </button>
        </div>
      </div>
    </div>
  `,
})
export class RaceReplayComponent implements OnInit, OnChanges, OnDestroy {
  @Input({ required: true }) state!: GameState;
  @Output() close = new EventEmitter<void>();

  step = -1;
  playing = false;
  displayState: GameState | null = null;
  currentMove: ReplayMove | null = null;

  private playTimer: ReturnType<typeof setInterval> | null = null;

  get totalMoves(): number {
    return this.state.moveHistory?.length ?? 0;
  }

  ngOnInit(): void {
    this.refresh();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['state']) {
      this.step = Math.min(this.step, this.totalMoves - 1);
      this.refresh();
    }
  }

  ngOnDestroy(): void {
    this.stopPlay();
  }

  onScrub(event: Event): void {
    this.stopPlay();
    this.step = Number((event.target as HTMLInputElement).value);
    this.refresh();
  }

  stepToStart(): void {
    this.stopPlay();
    this.step = -1;
    this.refresh();
  }

  stepBack(): void {
    this.stopPlay();
    this.step = Math.max(-1, this.step - 1);
    this.refresh();
  }

  stepForward(): void {
    if (this.step >= this.totalMoves - 1) {
      this.stopPlay();
      return;
    }
    this.step += 1;
    this.refresh();
    if (this.playing && this.step >= this.totalMoves - 1) {
      this.stopPlay();
    }
  }

  stepToEnd(): void {
    this.stopPlay();
    this.step = Math.max(-1, this.totalMoves - 1);
    this.refresh();
  }

  togglePlay(): void {
    if (this.playing) {
      this.stopPlay();
      return;
    }
    if (this.step >= this.totalMoves - 1) {
      this.step = -1;
      this.refresh();
    }
    this.playing = true;
    this.playTimer = setInterval(() => this.stepForward(), 650);
  }

  private stopPlay(): void {
    this.playing = false;
    if (this.playTimer) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
  }

  private refresh(): void {
    this.displayState = buildReplayState(this.state, this.step);
    this.currentMove = this.step >= 0 ? (this.state.moveHistory?.[this.step] ?? null) : null;
  }
}
