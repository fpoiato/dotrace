import { Injectable, inject } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { Top10Entry } from '../models/ws-types';
import { ApiService } from './api.service';

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
      const entries = Array.isArray(response?.payload?.entries) ? response.payload.entries : [];
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
