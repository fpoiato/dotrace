import { AsyncPipe } from '@angular/common';
import { Component, Input, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { BehaviorSubject, Subscription, interval } from 'rxjs';
import {
  GameState,
  LeaderboardEntry,
  buildLeaderboard,
  formatRaceTime,
} from '../../core/models/ws-types';

@Component({
  selector: 'app-leaderboard',
  standalone: true,
  imports: [AsyncPipe, TranslateModule],
  templateUrl: './leaderboard.component.html',
})
export class LeaderboardComponent implements OnChanges, OnDestroy {
  @Input() state: GameState | null = null;
  @Input() expanded = false;

  readonly formatRaceTime = formatRaceTime;

  private readonly entriesSubject = new BehaviorSubject<LeaderboardEntry[]>([]);
  readonly entries$ = this.entriesSubject.asObservable();

  private tickSub: Subscription | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['state']) {
      this.refresh();
      this.syncTicker();
    }
  }

  ngOnDestroy(): void {
    this.tickSub?.unsubscribe();
  }

  private syncTicker(): void {
    this.tickSub?.unsubscribe();
    if (this.state?.phase === 'GAME_ROUND') {
      this.tickSub = interval(1000).subscribe(() => this.refresh());
    }
  }

  private refresh(): void {
    if (!this.state?.raceStartedAt) {
      this.entriesSubject.next([]);
      return;
    }
    this.entriesSubject.next(buildLeaderboard(this.state));
  }

  lapTimeLabel(entry: LeaderboardEntry): string {
    if (entry.finishOrder !== undefined && entry.totalTimeMs !== undefined) {
      return formatRaceTime(entry.totalTimeMs);
    }
    if (entry.lapTimes.length > 0) {
      return formatRaceTime(entry.lapTimes[entry.lapTimes.length - 1]!);
    }
    if (entry.currentLapMs !== undefined) {
      return formatRaceTime(entry.currentLapMs);
    }
    return '—';
  }

  rankBadge(rank: number, finishOrder?: number): string {
    if (finishOrder === 1) return '🥇';
    if (finishOrder === 2) return '🥈';
    if (finishOrder === 3) return '🥉';
    return `${rank}`;
  }
}
