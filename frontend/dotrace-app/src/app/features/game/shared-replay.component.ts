import { Component, OnInit, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { GameState } from '../../core/models/ws-types';
import { ReplayShareService } from '../../core/services/replay-share.service';
import { LanguageToggleComponent } from '../../shared/language-toggle.component';
import { LoadingSpinnerComponent } from '../../shared/loading-spinner.component';
import { ReplayViewerComponent } from './replay-viewer.component';

@Component({
  selector: 'app-shared-replay',
  standalone: true,
  imports: [
    TranslateModule,
    RouterLink,
    ReplayViewerComponent,
    LoadingSpinnerComponent,
    LanguageToggleComponent,
  ],
  template: `
    <div class="mx-auto flex min-h-0 w-full max-w-lg flex-1 flex-col overflow-y-auto px-4 py-6">
      <div class="mb-4 flex items-center justify-between">
        <a routerLink="/" class="text-lg font-black tracking-tight text-orange-400">
          {{ 'app.title' | translate }}
        </a>
        <app-language-toggle />
      </div>

      @if (loading) {
        <div class="flex flex-1 items-center justify-center py-16">
          <app-loading-spinner />
        </div>
      } @else if (error || !state) {
        <div class="flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
          <p class="text-base text-slate-300">{{ 'game.replayLinkInvalid' | translate }}</p>
          <a
            routerLink="/"
            class="min-h-12 rounded-xl bg-orange-500 px-6 py-3 text-base font-bold text-white active:bg-orange-600"
          >
            {{ 'game.replayBackHome' | translate }}
          </a>
        </div>
      } @else {
        <p class="mb-2 text-center text-sm text-slate-400">{{ 'game.replaySharedHint' | translate }}</p>
        <app-replay-viewer [state]="state" [standalone]="true" />
        <a
          routerLink="/"
          class="mt-4 min-h-12 w-full rounded-xl bg-slate-800 py-3 text-center text-base font-bold text-white active:bg-slate-700"
        >
          {{ 'game.replayBackHome' | translate }}
        </a>
      }
    </div>
  `,
})
export class SharedReplayComponent implements OnInit {
  private readonly share = inject(ReplayShareService);

  loading = true;
  error = false;
  state: GameState | null = null;

  async ngOnInit(): Promise<void> {
    const hash = window.location.hash;
    if (!hash || hash === '#') {
      this.loading = false;
      this.error = true;
      return;
    }
    try {
      const decoded = await this.share.decodeHash(hash);
      if (!decoded) {
        this.error = true;
      } else {
        this.state = decoded;
      }
    } catch {
      this.error = true;
    } finally {
      this.loading = false;
    }
  }
}
