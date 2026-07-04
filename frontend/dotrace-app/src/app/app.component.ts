import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { environment } from '../environments/environment';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `
    <div class="flex min-h-dvh flex-col">
      <main class="flex min-h-0 flex-1 flex-col">
        <router-outlet />
      </main>
      <footer class="shrink-0 pb-2 pt-3 text-center">
        <span class="text-[10px] text-slate-600">v{{ version }}</span>
      </footer>
    </div>
  `,
  styles: [`:host { display: block; }`],
})
export class AppComponent {
  readonly version = environment.version;
}
