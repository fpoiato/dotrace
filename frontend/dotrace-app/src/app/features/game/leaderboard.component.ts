import { Component, Input } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { GameState, Player, formatRaceTime } from '../../core/models/ws-types';

interface LeaderboardRow {
  player: Player;
  /** Finish position for finishers, null for DNF players. */
  finishPos: number | null;
  /** Overall position in the sorted table (1-based). */
  rank: number;
}

@Component({
  selector: 'app-leaderboard',
  standalone: true,
  imports: [TranslateModule],
  template: `
    <div class="celebrate mt-6 rounded-2xl bg-slate-900 border border-slate-700 shadow-xl">
      <!-- Header -->
      <div class="rounded-t-2xl bg-gradient-to-r from-orange-600 to-yellow-500 px-5 py-4 text-center">
        <h2 class="text-2xl font-black text-white">{{ 'game.raceOver' | translate }} 🏁</h2>
        <p class="mt-1 text-sm font-medium text-white/80">{{ 'game.leaderboard' | translate }}</p>
      </div>

      <!-- Scrollable table area -->
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-slate-700 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <th class="py-2 pl-4 pr-2 text-left">{{ 'game.lb.pos' | translate }}</th>
              <th class="py-2 px-2 text-left">{{ 'game.lb.driver' | translate }}</th>
              @for (n of lapRange; track n) {
                <th class="py-2 px-2 text-right">
                  {{ 'game.lb.lap' | translate : { n: n } }}
                </th>
              }
              @if (state.totalLaps > 1) {
                <th class="py-2 pl-2 pr-4 text-right">{{ 'game.lb.total' | translate }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of rows; track row.player.connectionId) {
              <tr
                class="border-b border-slate-800 last:border-0"
                [class.bg-slate-800]="row.rank % 2 === 0"
              >
                <!-- Position -->
                <td class="py-3 pl-4 pr-2 text-lg font-bold">
                  @switch (row.finishPos) {
                    @case (1) { <span>🥇</span> }
                    @case (2) { <span>🥈</span> }
                    @case (3) { <span>🥉</span> }
                    @default {
                      @if (row.finishPos !== null) {
                        <span class="text-base text-slate-300">{{ row.finishPos }}</span>
                      } @else {
                        <span class="text-xs font-semibold text-slate-500">{{ 'game.lb.dnf' | translate }}</span>
                      }
                    }
                  }
                </td>

                <!-- Driver name + color dot -->
                <td class="py-3 px-2">
                  <span class="flex items-center gap-2 truncate font-medium text-white">
                    <span
                      class="h-2.5 w-2.5 shrink-0 rounded-full"
                      [style.background]="row.player.color"
                    ></span>
                    {{ row.player.nickname }}
                  </span>
                </td>

                <!-- Per-lap splits -->
                @for (n of lapRange; track n) {
                  <td class="py-3 px-2 text-right font-mono text-xs">
                    <span [class.text-slate-400]="lapCompleted(row.player, n)" [class.text-slate-600]="!lapCompleted(row.player, n)">
                      {{ lapDisplay(row.player, n) }}
                    </span>
                  </td>
                }

                <!-- Total / race time (only shown for multi-lap races) -->
                @if (state.totalLaps > 1) {
                  <td class="py-3 pl-2 pr-4 text-right font-mono text-xs font-semibold">
                    <span [class.text-orange-400]="row.finishPos !== null" [class.text-slate-600]="row.finishPos === null">
                      {{ totalDisplay(row.player) }}
                    </span>
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
})
export class LeaderboardComponent {
  @Input() state!: GameState;

  /** 1-based lap numbers for column headers, e.g. [1, 2, 3]. */
  get lapRange(): number[] {
    return Array.from({ length: this.state.totalLaps }, (_, i) => i + 1);
  }

  /** Sorted rows: finishers first (by finishOrder), then DNF players (by laps done desc). */
  get rows(): LeaderboardRow[] {
    const players = this.state.players;
    const finishers = players
      .filter((p) => p.finishOrder !== undefined)
      .sort((a, b) => a.finishOrder! - b.finishOrder!);
    const dnf = players
      .filter((p) => p.finishOrder === undefined)
      .sort((a, b) => b.lap - a.lap || a.joinOrder - b.joinOrder);
    return [...finishers, ...dnf].map((player, i) => ({
      player,
      finishPos: player.finishOrder ?? null,
      rank: i + 1,
    }));
  }

  /** Whether the player has a recorded time/round for the given 1-based lap number. */
  lapCompleted(player: Player, lapNumber: number): boolean {
    const idx = lapNumber - 1;
    return (player.lapTimes?.length ?? 0) > idx;
  }

  /**
   * Returns the display string for a single lap column.
   * - TIMED: split time (e.g. "1:23")
   * - TURNS: round number (e.g. "R5")
   * - Not yet reached: "—"
   */
  lapDisplay(player: Player, lapNumber: number): string {
    const idx = lapNumber - 1;
    if (this.state.gameMode === 'TURNS') {
      const lapRounds = player.lapRounds;
      if (!lapRounds || lapRounds.length <= idx) return '—';
      return `R${lapRounds[idx]}`;
    }
    const lapTimes = player.lapTimes;
    if (!lapTimes || lapTimes.length <= idx) return '—';
    const from = idx === 0 ? (this.state.raceStartedAt ?? lapTimes[0]) : lapTimes[idx - 1];
    return formatRaceTime(lapTimes[idx] - from);
  }

  /**
   * Total time (TIMED) or finish round (TURNS) for the race.
   * Shows "—" for DNF players.
   */
  totalDisplay(player: Player): string {
    if (player.finishOrder === undefined) return '—';
    if (this.state.gameMode === 'TURNS') {
      return player.finishRound !== undefined ? `R${player.finishRound}` : '—';
    }
    if (!player.finishedAt || !this.state.raceStartedAt) return '—';
    return formatRaceTime(player.finishedAt - this.state.raceStartedAt);
  }
}
