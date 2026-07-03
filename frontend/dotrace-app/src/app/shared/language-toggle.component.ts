import { Component, inject } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

@Component({
  selector: 'app-language-toggle',
  standalone: true,
  imports: [TranslateModule],
  template: `
    <div class="flex gap-2">
      <button
        type="button"
        class="min-h-11 min-w-11 rounded-lg px-3 text-sm font-medium transition"
        [class.bg-orange-500]="current === 'pt-BR'"
        [class.bg-slate-700]="current !== 'pt-BR'"
        (click)="setLang('pt-BR')"
      >
        PT
      </button>
      <button
        type="button"
        class="min-h-11 min-w-11 rounded-lg px-3 text-sm font-medium transition"
        [class.bg-orange-500]="current === 'en'"
        [class.bg-slate-700]="current !== 'en'"
        (click)="setLang('en')"
      >
        EN
      </button>
    </div>
  `,
})
export class LanguageToggleComponent {
  private readonly translate = inject(TranslateService);
  current = localStorage.getItem('dotrace-lang') ?? 'pt-BR';

  setLang(lang: string): void {
    this.current = lang;
    localStorage.setItem('dotrace-lang', lang);
    this.translate.use(lang);
  }
}
