import { Component, Input, OnChanges } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import {
  GameState,
  LeaderboardEntry,
  buildLeaderboard,
  fastestLapOf,
  formatLapTime,
  formatRaceTime,
} from '../../core/models/ws-types';

/**
 * Lap-time leaderboard: live standings during the race and final results on
 * game over. Each row shows rank, driver, progress (or total time once
 * finished) and the stopwatch for every completed lap. The overall fastest
 * lap gets the classic purple; a driver's personal best gets green.
 */
@Component({
  selector: 'app-race-leaderboard',
  standalone: true,
  imports: [TranslateModule],
  template: `
    <ol class="space-y-2">
      @for (entry of entries; track entry.connectionId) {
        <li class="rounded-lg bg-slate-900/80 px-3 py-2">
          <div class="flex items-center justify-between gap-2 text-sm">
            <span class="flex min-w-0 items-center gap-2">
              <span class="w-5 shrink-0 text-right font-mono font-bold text-slate-400">{{ entry.rank }}</span>
              <span class="h-2.5 w-2.5 shrink-0 rounded-full" [style.background]="entry.color"></span>
              <span class="truncate font-medium text-slate-200">{{ entry.nickname }}</span>
            </span>
            <span class="shrink-0 font-mono text-xs text-slate-400">
              @if (entry.totalTimeMs !== null) {
                🏁 {{ formatRaceTime(entry.totalTimeMs) }}
              } @else {
                {{ 'game.lap' | translate }} {{ entry.lap }}/{{ state.totalLaps }}
              }
            </span>
          </div>
          @if (entry.lapTimesMs.length > 0) {
            <div class="mt-1.5 flex flex-wrap gap-1.5 pl-7">
              @for (lapMs of entry.lapTimesMs; track $index) {
                <span
                  class="rounded px-1.5 py-0.5 font-mono text-[11px]"
                  [class.bg-purple-900]="isFastestLap(entry, lapMs)"
                  [class.text-purple-300]="isFastestLap(entry, lapMs)"
                  [class.bg-green-900]="!isFastestLap(entry, lapMs) && isPersonalBest(entry, lapMs)"
                  [class.text-green-300]="!isFastestLap(entry, lapMs) && isPersonalBest(entry, lapMs)"
                  [class.bg-slate-800]="!isFastestLap(entry, lapMs) && !isPersonalBest(entry, lapMs)"
                  [class.text-slate-400]="!isFastestLap(entry, lapMs) && !isPersonalBest(entry, lapMs)"
                >
                  L{{ $index + 1 }} {{ formatLapTime(lapMs) }}
                </span>
              }
            </div>
          }
        </li>
      }
    </ol>
    @if (fastest) {
      <p class="mt-3 text-center text-xs font-medium text-purple-300">
        ⚡ {{ 'game.fastestLap' | translate }}: {{ fastestNickname() }} — {{ formatLapTime(fastest.timeMs) }}
      </p>
    }
  `,
})
export class RaceLeaderboardComponent implements OnChanges {
  @Input({ required: true }) state!: GameState;

  entries: LeaderboardEntry[] = [];
  fastest: { connectionId: string; timeMs: number } | null = null;

  readonly formatLapTime = formatLapTime;
  readonly formatRaceTime = formatRaceTime;

  ngOnChanges(): void {
    this.entries = buildLeaderboard(this.state);
    this.fastest = fastestLapOf(this.entries);
  }

  isFastestLap(entry: LeaderboardEntry, lapMs: number): boolean {
    return (
      this.fastest !== null &&
      this.fastest.connectionId === entry.connectionId &&
      this.fastest.timeMs === lapMs
    );
  }

  isPersonalBest(entry: LeaderboardEntry, lapMs: number): boolean {
    return entry.lapTimesMs.length > 1 && entry.bestLapMs === lapMs;
  }

  fastestNickname(): string {
    return this.entries.find((e) => e.connectionId === this.fastest?.connectionId)?.nickname ?? '';
  }
}
