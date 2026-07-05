import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { TrackDefinition } from '../core/models/ws-types';

@Component({
  selector: 'app-track-picker',
  standalone: true,
  imports: [TranslateModule],
  template: `
    <div>
      <h2 class="mb-2 text-sm font-medium text-slate-400">{{ 'lobby.selectTrack' | translate }}</h2>
      <button
        type="button"
        (click)="openPicker()"
        class="mb-6 flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border-2 px-4 text-left transition hover:border-slate-500"
        [class]="selectedTrackId ? 'border-orange-500 bg-orange-500/10' : 'border-slate-600'"
      >
        <span class="font-semibold" [class.text-slate-400]="!selectedTrackId">
          @if (selectedTrackId) {
            {{ selectedTrackNameKey | translate }}
          } @else {
            {{ 'lobby.selectTrackPlaceholder' | translate }}
          }
        </span>
        <span class="shrink-0 text-slate-400" aria-hidden="true">▾</span>
      </button>
    </div>

    @if (open) {
      <div
        class="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center"
        (click)="closePicker()"
      >
        <div
          class="flex max-h-[85dvh] w-full max-w-md flex-col rounded-t-2xl bg-slate-900 sm:rounded-2xl"
          (click)="$event.stopPropagation()"
          role="dialog"
          aria-modal="true"
          [attr.aria-label]="'lobby.selectTrack' | translate"
        >
          <div class="shrink-0 border-b border-slate-700 px-5 py-4">
            <h3 class="text-lg font-bold text-orange-400">{{ 'lobby.selectTrack' | translate }}</h3>
          </div>

          <div class="overflow-y-auto overscroll-contain px-5 py-4">
            <div class="grid grid-cols-1 gap-3">
              @for (track of tracks; track track.id) {
                <button
                  type="button"
                  (click)="pick(track.id)"
                  class="min-h-14 rounded-xl border-2 px-4 text-left font-semibold transition"
                  [class]="selectedTrackId === track.id ? 'border-orange-500 bg-orange-500/20' : 'border-slate-600 hover:border-slate-500'"
                >
                  {{ track.nameKey | translate }}
                </button>
              }
            </div>
          </div>

          <div class="shrink-0 border-t border-slate-700 p-5">
            <button
              type="button"
              (click)="closePicker()"
              class="min-h-12 w-full rounded-xl bg-slate-700 font-semibold text-white transition hover:bg-slate-600"
            >
              {{ 'common.close' | translate }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class TrackPickerComponent implements OnInit, OnDestroy {
  @Input({ required: true }) tracks!: TrackDefinition[];
  @Input() selectedTrackId = '';
  @Output() readonly trackSelected = new EventEmitter<string>();

  open = false;

  get selectedTrackNameKey(): string {
    return this.tracks.find((t) => t.id === this.selectedTrackId)?.nameKey ?? '';
  }

  ngOnInit(): void {
    if (this.open) {
      document.body.classList.add('scroll-locked');
    }
  }

  ngOnDestroy(): void {
    document.body.classList.remove('scroll-locked');
  }

  openPicker(): void {
    this.open = true;
    document.body.classList.add('scroll-locked');
  }

  closePicker(): void {
    this.open = false;
    document.body.classList.remove('scroll-locked');
  }

  pick(trackId: string): void {
    this.trackSelected.emit(trackId);
    this.closePicker();
  }
}
