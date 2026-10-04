import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { environment } from '../environments/environment';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `
    <div
      class="flex h-full min-h-0 flex-col overflow-hidden pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]"
    >
      <main class="flex min-h-0 flex-1 flex-col">
        <router-outlet />
      </main>
      <footer class="shrink-0 pb-[max(0.25rem,env(safe-area-inset-bottom))] pt-1 text-center">
        <span class="text-[10px] text-slate-600">v{{ version }}</span>
      </footer>
    </div>
  `,
  styles: [`:host { display: block; height: 100%; }`],
})
export class AppComponent {
  readonly version = environment.version;
}
