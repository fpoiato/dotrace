import { Component } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-loading-spinner',
  standalone: true,
  imports: [TranslateModule],
  template: `
    <div class="flex flex-col items-center gap-3 py-8">
      <div class="h-10 w-10 animate-spin rounded-full border-4 border-orange-500 border-t-transparent"></div>
      <p class="text-slate-300">{{ 'common.loading' | translate }}</p>
    </div>
  `,
})
export class LoadingSpinnerComponent {}
