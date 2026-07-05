import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  OnInit,
  Output,
  ViewChild,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { PAPER_COLORS, TRACKS } from '../core/models/tracks';
import { TrackDefinition } from '../core/models/ws-types';

/** Internal pixels per cell for the thumbnail raster. */
const S = 3;

/** Small canvas preview of a circuit: dark backdrop, track ribbon, finish stripe. */
@Component({
  selector: 'app-track-thumbnail',
  standalone: true,
  template: `<canvas #canvas class="block h-full w-full rounded-lg"></canvas>`,
})
export class TrackThumbnailComponent implements AfterViewInit {
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @Input({ required: true }) track!: TrackDefinition;

  ngAfterViewInit(): void {
    const canvas = this.canvasRef.nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const track = this.track;
    canvas.width = track.width * S;
    canvas.height = track.height * S;

    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let y = 0; y < track.height; y++) {
      for (let x = 0; x < track.width; x++) {
        const tile = track.grid[y][x];
        if (tile === 'track') {
          ctx.fillStyle = '#cbd5e1';
          ctx.fillRect(x * S, y * S, S, S);
        } else if (tile === 'finish') {
          ctx.fillStyle = PAPER_COLORS.finish;
          ctx.fillRect(x * S, y * S, S, S);
        }
      }
    }
  }
}

/**
 * Full-screen popup for picking a circuit. Scrollable list with one card per
 * track (thumbnail + name); tapping a card selects it and closes the popup.
 */
@Component({
  selector: 'app-track-picker',
  standalone: true,
  imports: [TranslateModule, TrackThumbnailComponent],
  template: `
    <div
      class="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center"
      (click)="close.emit()"
    >
      <div
        class="flex max-h-[85dvh] w-full max-w-md flex-col rounded-t-2xl bg-slate-900 sm:rounded-2xl"
        (click)="$event.stopPropagation()"
      >
        <div class="flex items-center justify-between p-5 pb-3">
          <h2 class="text-xl font-bold text-orange-400">{{ 'lobby.selectTrack' | translate }}</h2>
          <button
            type="button"
            (click)="close.emit()"
            [attr.aria-label]="'common.close' | translate"
            class="min-h-10 min-w-10 rounded-full bg-slate-800 font-bold text-slate-300 hover:text-white"
          >
            ✕
          </button>
        </div>

        <div class="overflow-y-auto overscroll-contain px-5 pb-5">
          <div class="grid grid-cols-1 gap-3">
            @for (track of tracks; track track.id) {
              <button
                type="button"
                (click)="pick(track.id)"
                class="rounded-xl border-2 p-3 text-left transition"
                [class]="
                  selectedTrackId === track.id
                    ? 'border-orange-500 bg-orange-500/20'
                    : 'border-slate-600 hover:border-slate-400'
                "
              >
                <app-track-thumbnail [track]="track" />
                <div class="mt-2 flex items-center justify-between">
                  <span class="font-semibold text-white">{{ track.nameKey | translate }}</span>
                  @if (selectedTrackId === track.id) {
                    <span class="text-sm font-bold text-orange-400">✓</span>
                  }
                </div>
              </button>
            }
          </div>
        </div>
      </div>
    </div>
  `,
})
export class TrackPickerComponent implements OnInit, OnDestroy {
  @Input() selectedTrackId = '';
  @Output() readonly select = new EventEmitter<string>();
  @Output() readonly close = new EventEmitter<void>();

  readonly tracks = TRACKS;

  ngOnInit(): void {
    document.body.classList.add('scroll-locked');
  }

  ngOnDestroy(): void {
    document.body.classList.remove('scroll-locked');
  }

  pick(trackId: string): void {
    this.select.emit(trackId);
    this.close.emit();
  }
}
