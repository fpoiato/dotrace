import { Component, EventEmitter, OnDestroy, OnInit, Output } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-how-to-play',
  standalone: true,
  imports: [TranslateModule],
  template: `
    <div
      class="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center"
      (click)="close.emit()"
    >
      <div
        class="max-h-[85dvh] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-2xl bg-slate-900 p-5 sm:rounded-2xl"
        (click)="$event.stopPropagation()"
      >
        <h2 class="mb-4 text-xl font-bold text-orange-400">{{ 'howto.title' | translate }}</h2>

        <ol class="space-y-4">
          @for (section of sections; track section.n) {
            <li class="flex gap-3">
              <span class="text-2xl">{{ section.icon }}</span>
              <div>
                <h3 class="font-semibold text-white">{{ 'howto.' + section.n + '.title' | translate }}</h3>
                <p class="mt-0.5 text-sm leading-relaxed text-slate-300">
                  {{ 'howto.' + section.n + '.body' | translate }}
                </p>
              </div>
            </li>
          }
        </ol>

        <button
          type="button"
          (click)="close.emit()"
          class="mt-6 min-h-12 w-full rounded-xl bg-orange-500 font-bold text-white transition hover:bg-orange-600"
        >
          {{ 'howto.close' | translate }}
        </button>
      </div>
    </div>
  `,
})
export class HowToPlayComponent implements OnInit, OnDestroy {
  @Output() readonly close = new EventEmitter<void>();

  ngOnInit(): void {
    document.body.classList.add('scroll-locked');
  }

  ngOnDestroy(): void {
    document.body.classList.remove('scroll-locked');
  }

  readonly sections = [
    { n: 1, icon: '🏁' },
    { n: 2, icon: '🎲' },
    { n: 3, icon: '🚗' },
    { n: 4, icon: '🎚️' },
    { n: 5, icon: '🌿' },
    { n: 6, icon: '📳' },
    { n: 7, icon: '🏆' },
    { n: 8, icon: '⛽' },
  ];
}
