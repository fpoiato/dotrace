import { Component, Input } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import {
  GameState,
  Player,
  SessionPlayerStats,
  bestLapMs,
  bestLapRounds,
  buildSessionRanking,
  fastestLapHolderIds,
  fewestRoundLapHolderIds,
  formatRaceTime,
  lapSplitMs,
  lapSplitRounds,
} from '../../core/models/ws-types';

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

      <!-- Race awards -->
      @if (winner || fastestLapPlayer || fewestRoundPlayer) {
        <div class="grid gap-2 border-b border-slate-800 px-4 py-3 sm:grid-cols-3">
          @if (winner) {
            <div class="rounded-xl bg-slate-800/80 px-3 py-2 text-center">
              <p class="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {{ 'game.lb.winner' | translate }}
              </p>
              <p class="mt-0.5 truncate text-sm font-bold text-orange-300">{{ winner.nickname }}</p>
            </div>
          }
          @if (fastestLapPlayer; as fl) {
            <div class="rounded-xl bg-slate-800/80 px-3 py-2 text-center">
              <p class="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {{ 'game.lb.fastestLap' | translate }}
              </p>
              <p class="mt-0.5 truncate text-sm font-bold text-violet-300">
                {{ fl.nickname }}
                <span class="font-mono text-xs text-violet-200/80">{{ fastestLapLabel }}</span>
              </p>
            </div>
          }
          @if (fewestRoundPlayer; as fr) {
            <div class="rounded-xl bg-slate-800/80 px-3 py-2 text-center">
              <p class="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {{ 'game.lb.fewestRounds' | translate }}
              </p>
              <p class="mt-0.5 truncate text-sm font-bold text-emerald-300">
                {{ fr.nickname }}
                <span class="font-mono text-xs text-emerald-200/80">{{ fewestRoundsLabel }}</span>
              </p>
            </div>
          }
        </div>
      }

      <!-- Scrollable race results -->
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
                    @if (row.player.isBot) {
                      <span class="rounded bg-sky-900 px-1.5 py-0.5 text-[10px] font-bold text-sky-300">
                        {{ 'common.bot' | translate }}
                      </span>
                    }
                  </span>
                </td>

                <!-- Per-lap splits -->
                @for (n of lapRange; track n) {
                  <td class="py-3 px-2 text-right font-mono text-xs">
                    <span
                      [class.text-violet-300]="isFastestLapCell(row.player, n)"
                      [class.font-bold]="isFastestLapCell(row.player, n) || isFewestRoundCell(row.player, n)"
                      [class.text-emerald-300]="isFewestRoundCell(row.player, n)"
                      [class.text-slate-400]="
                        lapCompleted(row.player, n) &&
                        !isFastestLapCell(row.player, n) &&
                        !isFewestRoundCell(row.player, n)
                      "
                      [class.text-slate-600]="!lapCompleted(row.player, n)"
                    >
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

      <!-- Session ranking across rematches -->
      @if (sessionRows.length > 0) {
        <div class="border-t border-slate-700">
          <div class="px-5 py-3">
            <h3 class="text-center text-sm font-bold uppercase tracking-wide text-orange-300">
              {{ 'game.sessionRanking' | translate }}
            </h3>
            <p class="mt-1 text-center text-xs text-slate-500">
              {{ 'game.sessionRankingHint' | translate }}
            </p>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-slate-700 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  <th class="py-2 pl-4 pr-2 text-left">{{ 'game.lb.pos' | translate }}</th>
                  <th class="py-2 px-2 text-left">{{ 'game.lb.driver' | translate }}</th>
                  <th class="py-2 px-2 text-right">{{ 'game.lb.races' | translate }}</th>
                  <th class="py-2 px-2 text-right">{{ 'game.lb.wins' | translate }}</th>
                  <th class="py-2 px-2 text-right">{{ 'game.lb.bestLap' | translate }}</th>
                  <th class="py-2 pl-2 pr-4 text-right">{{ 'game.lb.bestRounds' | translate }}</th>
                </tr>
              </thead>
              <tbody>
                @for (row of sessionRows; track row.connectionId; let i = $index) {
                  <tr
                    class="border-b border-slate-800 last:border-0"
                    [class.bg-slate-800]="i % 2 === 1"
                  >
                    <td class="py-2.5 pl-4 pr-2 text-sm font-bold text-slate-300">{{ i + 1 }}</td>
                    <td class="py-2.5 px-2">
                      <span class="flex items-center gap-2 truncate font-medium text-white">
                        <span
                          class="h-2.5 w-2.5 shrink-0 rounded-full"
                          [style.background]="row.color"
                        ></span>
                        {{ row.nickname }}
                      </span>
                    </td>
                    <td class="py-2.5 px-2 text-right font-mono text-xs text-slate-300">{{ row.races }}</td>
                    <td class="py-2.5 px-2 text-right font-mono text-xs font-semibold text-orange-300">
                      {{ row.wins }}
                    </td>
                    <td class="py-2.5 px-2 text-right font-mono text-xs text-violet-300">
                      {{ row.bestLapMs !== undefined ? formatRaceTime(row.bestLapMs) : '—' }}
                    </td>
                    <td class="py-2.5 pl-2 pr-4 text-right font-mono text-xs text-emerald-300">
                      {{ row.bestLapRounds !== undefined ? row.bestLapRounds + 'r' : '—' }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>
      }
    </div>
  `,
})
export class LeaderboardComponent {
  @Input() state!: GameState;

  readonly formatRaceTime = formatRaceTime;

  private fastestIds: string[] = [];
  private fewestIds: string[] = [];
  private raceBestLapMs: number | undefined;
  private raceBestLapRounds: number | undefined;

  /** 1-based lap numbers for column headers, e.g. [1, 2, 3]. */
  get lapRange(): number[] {
    return Array.from({ length: this.state.totalLaps }, (_, i) => i + 1);
  }

  /** Sorted rows: finishers first (by finishOrder), then DNF players (by laps done desc). */
  get rows(): LeaderboardRow[] {
    this.refreshAwards();
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

  get sessionRows(): SessionPlayerStats[] {
    return buildSessionRanking(this.state);
  }

  get winner(): Player | undefined {
    return this.state.players.find((p) => p.finishOrder === 1);
  }

  get fastestLapPlayer(): Player | undefined {
    this.refreshAwards();
    const id = this.fastestIds[0];
    return id ? this.state.players.find((p) => p.connectionId === id) : undefined;
  }

  get fewestRoundPlayer(): Player | undefined {
    this.refreshAwards();
    // Prefer a dedicated TURNS award; still show when any lapRounds exist.
    const id = this.fewestIds[0];
    return id ? this.state.players.find((p) => p.connectionId === id) : undefined;
  }

  get fastestLapLabel(): string {
    return this.raceBestLapMs !== undefined ? formatRaceTime(this.raceBestLapMs) : '';
  }

  get fewestRoundsLabel(): string {
    return this.raceBestLapRounds !== undefined ? `${this.raceBestLapRounds}r` : '';
  }

  /** Whether the player has a recorded time/round for the given 1-based lap number. */
  lapCompleted(player: Player, lapNumber: number): boolean {
    const idx = lapNumber - 1;
    return (player.lapTimes?.length ?? 0) > idx;
  }

  isFastestLapCell(player: Player, lapNumber: number): boolean {
    this.refreshAwards();
    if (!this.fastestIds.includes(player.connectionId) || this.raceBestLapMs === undefined) {
      return false;
    }
    return lapSplitMs(player, lapNumber, this.state.raceStartedAt) === this.raceBestLapMs;
  }

  isFewestRoundCell(player: Player, lapNumber: number): boolean {
    this.refreshAwards();
    if (!this.fewestIds.includes(player.connectionId) || this.raceBestLapRounds === undefined) {
      return false;
    }
    return lapSplitRounds(player, lapNumber) === this.raceBestLapRounds;
  }

  /**
   * Returns the display string for a single lap column.
   * - TIMED: split time (e.g. "1:23")
   * - TURNS: rounds used on that lap (e.g. "5r")
   * - Not yet reached: "—"
   */
  lapDisplay(player: Player, lapNumber: number): string {
    if (this.state.gameMode === 'TURNS') {
      const split = lapSplitRounds(player, lapNumber);
      return split === undefined ? '—' : `${split}r`;
    }
    const split = lapSplitMs(player, lapNumber, this.state.raceStartedAt);
    return split === undefined ? '—' : formatRaceTime(split);
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

  private refreshAwards(): void {
    this.fastestIds = fastestLapHolderIds(this.state);
    this.fewestIds = fewestRoundLapHolderIds(this.state);
    this.raceBestLapMs = undefined;
    this.raceBestLapRounds = undefined;
    for (const p of this.state.players) {
      const ms = bestLapMs(p, this.state.raceStartedAt);
      if (ms !== undefined && (this.raceBestLapMs === undefined || ms < this.raceBestLapMs)) {
        this.raceBestLapMs = ms;
      }
      const rounds = bestLapRounds(p);
      if (
        rounds !== undefined &&
        (this.raceBestLapRounds === undefined || rounds < this.raceBestLapRounds)
      ) {
        this.raceBestLapRounds = rounds;
      }
    }
  }
}
