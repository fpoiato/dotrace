import { NgClass } from '@angular/common';
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
 * Race standings with per-lap timing: finishers first (by finish order),
 * then everyone still racing by laps completed and fastest lap. Reads from
 * the host-authoritative game state, so it stays live on every client.
 */
@Component({
  selector: 'app-leaderboard',
  standalone: true,
  imports: [NgClass, TranslateModule],
  templateUrl: './leaderboard.component.html',
})
export class LeaderboardComponent implements OnChanges {
  @Input({ required: true }) state!: GameState;
  /** Compact mode drops the total-time column (used in tight spots). */
  @Input() compact = false;

  entries: LeaderboardEntry[] = [];

  readonly formatLapTime = formatLapTime;
  readonly formatRaceTime = formatRaceTime;

  ngOnChanges(): void {
    this.entries = this.state ? buildLeaderboard(this.state) : [];
  }

  medal(entry: LeaderboardEntry, index: number): string {
    if (!entry.finished) return `${index + 1}`;
    switch (entry.finishOrder) {
      case 1:
        return '🥇';
      case 2:
        return '🥈';
      case 3:
        return '🥉';
      default:
        return `${entry.finishOrder}`;
    }
  }
}
