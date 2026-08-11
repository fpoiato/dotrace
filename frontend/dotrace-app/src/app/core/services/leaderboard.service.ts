import { Injectable, inject } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { Top10Entry } from '../models/ws-types';
import { ApiService } from './api.service';

/** Keep in sync with MAX_PLAUSIBLE_LAP_MS on the server leaderboard. */
const MAX_PLAUSIBLE_LAP_MS = 10 * 60 * 1000;

function sanitizeBestLapMs(ms: number | undefined): number | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined;
  const n = Math.floor(ms);
  return n > MAX_PLAUSIBLE_LAP_MS ? undefined : n;
}

/** Wins → best lap → fewest rounds → name (matches server Top 10). */
function compareTop10(a: Top10Entry, b: Top10Entry): number {
  if (b.wins !== a.wins) return b.wins - a.wins;
  const aLap = sanitizeBestLapMs(a.bestLapMs) ?? Number.POSITIVE_INFINITY;
  const bLap = sanitizeBestLapMs(b.bestLapMs) ?? Number.POSITIVE_INFINITY;
  if (aLap !== bLap) return aLap - bLap;
  const aRounds = a.bestLapRounds ?? Number.POSITIVE_INFINITY;
  const bRounds = b.bestLapRounds ?? Number.POSITIVE_INFINITY;
  if (aRounds !== bRounds) return aRounds - bRounds;
  return a.nickname.localeCompare(b.nickname);
}

@Injectable({ providedIn: 'root' })
export class LeaderboardService {
  private readonly api = inject(ApiService);
  private readonly top10Subject = new BehaviorSubject<Top10Entry[]>([]);
  private readonly loadingSubject = new BehaviorSubject<boolean>(false);

  readonly top10$ = this.top10Subject.asObservable();
  readonly loading$ = this.loadingSubject.asObservable();

  get top10(): Top10Entry[] {
    return this.top10Subject.value;
  }

  /**
   * Fetch the global Top 10 over HTTP — no WebSocket required on the landing page.
   */
  async refreshTop10(): Promise<Top10Entry[]> {
    this.loadingSubject.next(true);
    try {
      const response = await this.api.getTop10<{ entries: Top10Entry[] }>();
      const raw = Array.isArray(response?.payload?.entries) ? response.payload.entries : [];
      const entries = raw
        .map((row) => ({
          ...row,
          bestLapMs: sanitizeBestLapMs(row.bestLapMs),
        }))
        .sort(compareTop10)
        .slice(0, 10);
      this.top10Subject.next(entries);
      return entries;
    } catch {
      // Keep whatever we last showed; landing still works without the board.
      return this.top10Subject.value;
    } finally {
      this.loadingSubject.next(false);
    }
  }
}
