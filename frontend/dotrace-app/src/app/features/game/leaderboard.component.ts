import { Component, Input, OnChanges } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import {
  GameState,
  LeaderboardEntry,
  buildLeaderboard,
  formatLapTime,
  formatRaceTime,
} from '../../core/models/ws-types';

/**
 * Live standings table: rank, driver, current lap, best lap and last lap /
 * total time. The overall fastest lap is highlighted in purple (F1 style).
 * With [detailed] on (game over), every lap split is listed per driver.
 */
@Component({
  selector: 'app-leaderboard',
  standalone: true,
  imports: [TranslateModule],
  template: `
    <table class="w-full text-xs">
      <thead>
        <tr class="text-slate-500">
          <th class="w-8 px-3 py-2 text-left font-medium">#</th>
          <th class="px-1 py-2 text-left font-medium">{{ 'game.lb.driver' | translate }}</th>
          <th class="px-1 py-2 text-center font-medium">{{ 'game.lap' | translate }}</th>
          <th class="px-1 py-2 text-right font-medium">{{ 'game.lb.best' | translate }}</th>
          <th class="px-3 py-2 text-right font-medium">{{ 'game.lb.time' | translate }}</th>
        </tr>
      </thead>
      <tbody class="font-mono text-slate-300">
        @for (e of entries; track e.connectionId) {
          <tr class="border-t border-slate-700/60">
            <td class="px-3 py-2 font-bold">
              @switch (e.finishOrder) {
                @case (1) { 🥇 }
                @case (2) { 🥈 }
                @case (3) { 🥉 }
                @default { {{ e.rank }} }
              }
            </td>
            <td class="max-w-0 px-1 py-2">
              <span class="flex items-center gap-1.5">
                <span
                  class="h-2.5 w-2.5 shrink-0 rounded-full"
                  [style.background]="e.color"
                ></span>
                <span class="truncate">{{ e.nickname }}</span>
              </span>
            </td>
            <td class="px-1 py-2 text-center text-slate-400">
              @if (e.finishOrder !== undefined) {
                🏁
              } @else {
                {{ e.lap }}/{{ totalLaps }}
              }
            </td>
            <td
              class="px-1 py-2 text-right"
              [class.font-bold]="e.hasFastestLap"
              [class.text-purple-400]="e.hasFastestLap"
              [title]="e.hasFastestLap ? ('game.lb.fastestLap' | translate) : ''"
            >
              {{ e.bestLapMs !== undefined ? lapTime(e.bestLapMs) : '—' }}
            </td>
            <td class="px-3 py-2 text-right text-slate-400">
              @if (e.totalMs !== undefined) {
                {{ raceTime(e.totalMs) }}
              } @else if (e.lastLapMs !== undefined) {
                {{ lapTime(e.lastLapMs) }}
              } @else {
                —
              }
            </td>
          </tr>
          @if (detailed && e.lapTimes.length > 0) {
            <tr>
              <td></td>
              <td colspan="4" class="px-1 pb-2 pt-0">
                <span class="flex flex-wrap gap-x-3 gap-y-1 text-[0.65rem] text-slate-500">
                  @for (t of e.lapTimes; track $index) {
                    <span>L{{ $index + 1 }} {{ lapTime(t) }}</span>
                  }
                </span>
              </td>
            </tr>
          }
        }
      </tbody>
    </table>
  `,
})
export class LeaderboardComponent implements OnChanges {
  @Input() state: GameState | null = null;
  /** Show every lap split under each driver (final results view). */
  @Input() detailed = false;

  entries: LeaderboardEntry[] = [];
  totalLaps = 1;

  readonly lapTime = formatLapTime;
  readonly raceTime = formatRaceTime;

  ngOnChanges(): void {
    this.entries = this.state ? buildLeaderboard(this.state) : [];
    this.totalLaps = this.state?.totalLaps ?? 1;
  }
}
