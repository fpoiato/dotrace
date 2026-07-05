import {
  Component,
  EventEmitter,
  Input,
  OnDestroy,
  OnInit,
  Output,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import {
  GameState,
  MoveRecord,
  Player,
  PlayerStatus,
  Vector2D,
} from '../../core/models/ws-types';
import { TrackCanvasComponent } from './track-canvas.component';

interface ReplayPlayerState {
  connectionId: string;
  nickname: string;
  color: string;
  isHost: boolean;
  joinOrder: number;
  status: PlayerStatus;
  position: Vector2D;
  velocity: Vector2D;
  isOffTrack: boolean;
  trail: Vector2D[];
  lap: number;
  finishOrder?: number;
  finishedAt?: number;
  finishRound?: number;
  passedCheckpoint?: boolean;
  diceRoll?: number;
}

interface ReplayFrame {
  seq: number;
  round: number;
  movedId?: string;
  players: ReplayPlayerState[];
}

function buildReplayFrames(replayLog: MoveRecord[], players: Player[]): ReplayFrame[] {
  if (replayLog.length === 0) return [];

  const meta = new Map(
    players.map((p) => ({
      connectionId: p.connectionId,
      nickname: p.nickname,
      color: p.color,
      isHost: p.isHost,
      joinOrder: p.joinOrder,
      status: p.status,
      finishOrder: p.finishOrder,
      finishedAt: p.finishedAt,
      finishRound: p.finishRound,
      diceRoll: p.diceRoll,
    })).map((m) => [m.connectionId, m])
  );

  const currentState = new Map<string, ReplayPlayerState>();

  // Process seq=0 records (starting positions).
  const startRecords = replayLog.filter((r) => r.seq === 0);
  for (const rec of startRecords) {
    const info = meta.get(rec.connectionId);
    if (!info) continue;
    currentState.set(rec.connectionId, {
      connectionId: rec.connectionId,
      nickname: info.nickname,
      color: info.color,
      isHost: info.isHost,
      joinOrder: info.joinOrder,
      status: info.status,
      position: { ...rec.position },
      velocity: { ...rec.velocity },
      isOffTrack: rec.isOffTrack,
      trail: [{ ...rec.position }],
      lap: rec.lap,
      diceRoll: info.diceRoll,
    });
  }

  const frames: ReplayFrame[] = [];
  frames.push({
    seq: 0,
    round: 0,
    movedId: undefined,
    players: cloneStates(currentState),
  });

  const moves = replayLog.filter((r) => r.seq > 0).sort((a, b) => a.seq - b.seq);
  for (const rec of moves) {
    const ps = currentState.get(rec.connectionId);
    if (!ps) continue;

    // Build trail: start fresh when the player advances to the next lap.
    const trail = rec.lap > ps.lap ? [{ ...rec.position }] : [...ps.trail, { ...rec.position }];

    const info = meta.get(rec.connectionId);
    currentState.set(rec.connectionId, {
      ...ps,
      position: { ...rec.position },
      velocity: { ...rec.velocity },
      isOffTrack: rec.isOffTrack,
      lap: rec.lap,
      trail,
      // Apply finish metadata from final race state once the player's lap matches.
      finishOrder: info?.finishOrder,
      finishedAt: info?.finishedAt,
      finishRound: info?.finishRound,
    });

    frames.push({
      seq: rec.seq,
      round: rec.round,
      movedId: rec.connectionId,
      players: cloneStates(currentState),
    });
  }

  return frames;
}

function cloneStates(map: Map<string, ReplayPlayerState>): ReplayPlayerState[] {
  return [...map.values()].map((s) => ({
    ...s,
    position: { ...s.position },
    velocity: { ...s.velocity },
    trail: [...s.trail],
  }));
}

const SPEEDS = [1, 2, 4, 8] as const;
type Speed = (typeof SPEEDS)[number];

@Component({
  selector: 'app-replay-viewer',
  standalone: true,
  imports: [TrackCanvasComponent, TranslateModule],
  template: `
    <div class="mt-4 rounded-2xl bg-slate-800 p-4">
      <div class="mb-3 flex items-center justify-between">
        <h3 class="text-base font-bold text-orange-400">{{ 'game.replayTitle' | translate }}</h3>
        <button
          type="button"
          (click)="close()"
          class="rounded-lg bg-slate-700 px-3 py-1 text-sm text-slate-300 active:bg-slate-600"
        >
          {{ 'game.replayClose' | translate }}
        </button>
      </div>

      @if (frames.length === 0) {
        <p class="text-center text-sm text-slate-400">{{ 'game.replayNoData' | translate }}</p>
      } @else {
        <app-track-canvas [state]="replayState" />

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
            {{ isPlaying ? '⏸ ' + ('game.replayPause' | translate) : '▶ ' + ('game.replayPlay' | translate) }}
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
      }
    </div>
  `,
})
export class ReplayViewerComponent implements OnInit, OnDestroy {
  @Input() state!: GameState;
  @Output() closed = new EventEmitter<void>();

  frames: ReplayFrame[] = [];
  currentIndex = 0;
  isPlaying = false;
  playbackSpeed: Speed = 2;
  replayState: GameState | null = null;

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
    this.frames = buildReplayFrames(this.state.replayLog ?? [], this.state.players);
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

  ngOnDestroy(): void {
    this.pause();
  }
}
