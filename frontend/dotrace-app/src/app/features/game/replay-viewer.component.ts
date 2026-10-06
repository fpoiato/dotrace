import {
  Component,
  EventEmitter,
  Input,
  OnDestroy,
  OnInit,
  Output,
  inject,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { GameState, Player } from '../../core/models/ws-types';
import { ReplayShareService } from '../../core/services/replay-share.service';
import { TrackCanvasComponent } from './track-canvas.component';
import { ReplayFrame, buildReplayFrames } from './replay-frames';

const SPEEDS = [1, 2, 4, 8] as const;
type Speed = (typeof SPEEDS)[number];

@Component({
  selector: 'app-replay-viewer',
  standalone: true,
  imports: [TrackCanvasComponent, TranslateModule],
  template: `
    <div class="mt-4 rounded-2xl bg-slate-800 p-4" [class.mt-0]="standalone">
      <div class="mb-3 flex items-center justify-between gap-2">
        <h3 class="text-base font-bold text-orange-400">{{ 'game.replayTitle' | translate }}</h3>
        <div class="flex shrink-0 items-center gap-2">
          @if (frames.length > 0) {
            <button
              type="button"
              (click)="share()"
              [disabled]="sharing"
              class="rounded-lg bg-green-700 px-3 py-1 text-sm font-medium text-white active:bg-green-800 disabled:opacity-50"
            >
              {{ sharing ? ('game.replaySharing' | translate) : ('game.replayShare' | translate) }}
            </button>
          }
          @if (!standalone) {
            <button
              type="button"
              (click)="close()"
              class="rounded-lg bg-slate-700 px-3 py-1 text-sm text-slate-300 active:bg-slate-600"
            >
              {{ 'game.replayClose' | translate }}
            </button>
          }
        </div>
      </div>

      @if (frames.length === 0) {
        <p class="text-center text-sm text-slate-400">{{ 'game.replayNoData' | translate }}</p>
      } @else {
        <app-track-canvas [state]="replayState" [followLeader]="true" />

        <!-- Progress info -->
        <div class="mt-2 flex items-center justify-between text-xs text-slate-400">
          <span>
            {{ 'game.replayMove' | translate: { n: currentIndex, total: frames.length - 1 } }}
          </span>
          @if (currentFrame?.round) {
            <span>{{ 'game.round' | translate }} {{ currentFrame!.round }}</span>
          }
          @if (currentFrame?.movedId) {
            <span [style.color]="movedPlayerColor">{{ movedPlayerName }}</span>
          }
        </div>

        <!-- Scrubber -->
        <input
          type="range"
          min="0"
          [max]="frames.length - 1"
          [value]="currentIndex"
          (input)="onScrub($event)"
          class="mt-2 w-full accent-orange-500"
        />

        <!-- Controls -->
        <div class="mt-3 flex items-center justify-center gap-2">
          <button
            type="button"
            (click)="restart()"
            class="min-h-10 rounded-xl bg-slate-700 px-3 py-1 text-sm font-bold text-white active:bg-slate-600"
            title="Restart"
          >
            ⏮
          </button>
          <button
            type="button"
            (click)="stepBack()"
            class="min-h-10 rounded-xl bg-slate-700 px-3 py-1 text-sm font-bold text-white active:bg-slate-600"
            title="Previous move"
          >
            ◀
          </button>
          <button
            type="button"
            (click)="togglePlay()"
            class="min-h-10 min-w-[5rem] rounded-xl bg-orange-500 px-4 py-1 text-sm font-bold text-white active:bg-orange-600"
          >
            @if (isPlaying) {
              ⏸ {{ 'game.replayPause' | translate }}
            } @else {
              <!-- Hardcoded EN + notranslate: Chrome page-translate was turning i18n "Play" into "Jogar". -->
              <span class="notranslate" lang="en">▶ Play</span>
            }
          </button>
          <button
            type="button"
            (click)="stepForward()"
            class="min-h-10 rounded-xl bg-slate-700 px-3 py-1 text-sm font-bold text-white active:bg-slate-600"
            title="Next move"
          >
            ▶
          </button>
          <button
            type="button"
            (click)="stepToEnd()"
            class="min-h-10 rounded-xl bg-slate-700 px-3 py-1 text-sm font-bold text-white active:bg-slate-600"
            title="Last move"
          >
            ⏭
          </button>
        </div>

        <!-- Speed selector -->
        <div class="mt-2 flex items-center justify-center gap-2 text-xs">
          <span class="text-slate-400">{{ 'game.replaySpeed' | translate }}:</span>
          @for (s of speeds; track s) {
            <button
              type="button"
              (click)="setSpeed(s)"
              class="rounded px-2 py-0.5 font-mono font-bold"
              [class.bg-orange-500]="playbackSpeed === s"
              [class.text-white]="playbackSpeed === s"
              [class.bg-slate-700]="playbackSpeed !== s"
              [class.text-slate-300]="playbackSpeed !== s"
            >
              ×{{ s }}
            </button>
          }
        </div>

        @if (shareError) {
          <p class="mt-2 text-center text-xs text-red-400">{{ 'game.replayShareError' | translate }}</p>
        }
      }
    </div>
  `,
})
export class ReplayViewerComponent implements OnInit, OnDestroy {
  @Input() state!: GameState;
  /** When true, hide the close button (used on the public /replay page). */
  @Input() standalone = false;
  @Output() closed = new EventEmitter<void>();

  private readonly shareService = inject(ReplayShareService);

  frames: ReplayFrame[] = [];
  currentIndex = 0;
  isPlaying = false;
  playbackSpeed: Speed = 2;
  replayState: GameState | null = null;
  sharing = false;
  shareError = false;

  readonly speeds = SPEEDS;

  private playInterval: ReturnType<typeof setInterval> | null = null;

  get currentFrame(): ReplayFrame | null {
    return this.frames[this.currentIndex] ?? null;
  }

  get movedPlayerName(): string {
    const frame = this.currentFrame;
    if (!frame?.movedId) return '';
    return frame.players.find((p) => p.connectionId === frame.movedId)?.nickname ?? '';
  }

  get movedPlayerColor(): string {
    const frame = this.currentFrame;
    if (!frame?.movedId) return '';
    return frame.players.find((p) => p.connectionId === frame.movedId)?.color ?? '';
  }

  ngOnInit(): void {
    this.frames = buildReplayFrames(
      this.state.replayLog ?? [],
      this.state.players,
      this.state.podium ?? []
    );
    this.currentIndex = 0;
    this.updateReplayState();
  }

  private updateReplayState(): void {
    const frame = this.currentFrame;
    if (!frame || !this.state) {
      this.replayState = null;
      return;
    }
    this.replayState = {
      ...this.state,
      phase: 'GAME_OVER',
      players: frame.players as unknown as Player[],
      round: frame.round,
    };
  }

  togglePlay(): void {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  play(): void {
    if (this.isPlaying) return;
    if (this.currentIndex >= this.frames.length - 1) {
      this.currentIndex = 0;
      this.updateReplayState();
    }
    this.isPlaying = true;
    const ms = Math.round(600 / this.playbackSpeed);
    this.playInterval = setInterval(() => {
      this.stepForward();
    }, ms);
  }

  pause(): void {
    this.isPlaying = false;
    if (this.playInterval !== null) {
      clearInterval(this.playInterval);
      this.playInterval = null;
    }
  }

  stepForward(): void {
    if (this.currentIndex >= this.frames.length - 1) {
      this.pause();
      return;
    }
    this.currentIndex++;
    this.updateReplayState();
  }

  stepBack(): void {
    this.pause();
    if (this.currentIndex <= 0) return;
    this.currentIndex--;
    this.updateReplayState();
  }

  restart(): void {
    this.pause();
    this.currentIndex = 0;
    this.updateReplayState();
  }

  stepToEnd(): void {
    this.pause();
    this.currentIndex = this.frames.length - 1;
    this.updateReplayState();
  }

  onScrub(event: Event): void {
    this.pause();
    this.currentIndex = Number((event.target as HTMLInputElement).value);
    this.updateReplayState();
  }

  setSpeed(speed: Speed): void {
    const wasPlaying = this.isPlaying;
    this.pause();
    this.playbackSpeed = speed;
    if (wasPlaying) this.play();
  }

  close(): void {
    this.pause();
    this.closed.emit();
  }

  async share(): Promise<void> {
    if (this.sharing || !this.state) return;
    this.sharing = true;
    this.shareError = false;
    // Open before the save finishes so mobile still treats this as a tap.
    const popup = window.open('', '_blank');
    try {
      if (popup) popup.opener = null;
    } catch {
      // Some browsers reject clearing opener; the tab can still navigate.
    }
    try {
      const url = await this.shareService.buildShareUrl(this.state);
      if (!url) {
        popup?.close();
        this.shareError = true;
        return;
      }
      const whatsApp = this.shareService.getWhatsAppUrl(url);
      if (popup) {
        popup.location.href = whatsApp;
        return;
      }
      window.location.assign(whatsApp);
    } catch {
      popup?.close();
      this.shareError = true;
    } finally {
      this.sharing = false;
    }
  }

  ngOnDestroy(): void {
    this.pause();
  }
}
