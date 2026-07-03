import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { environment } from '../environments/environment';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `
    <router-outlet />
    <footer class="pb-2 pt-3 text-center">
      <span class="text-[10px] text-slate-600">v{{ version }}</span>
    </footer>
  `,
  styles: [`:host { display: block; min-height: 100vh; }`],
})
export class AppComponent {
  readonly version = environment.version;
}
