import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, firstValueFrom, timeout } from 'rxjs';
import { Top10Entry } from '../models/ws-types';
import { WebSocketService } from './websocket.service';

@Injectable({ providedIn: 'root' })
export class LeaderboardService {
  private readonly ws = inject(WebSocketService);
  private readonly top10Subject = new BehaviorSubject<Top10Entry[]>([]);
  private readonly loadingSubject = new BehaviorSubject<boolean>(false);

  readonly top10$ = this.top10Subject.asObservable();
  readonly loading$ = this.loadingSubject.asObservable();

  get top10(): Top10Entry[] {
    return this.top10Subject.value;
  }

  /**
   * Connect (if needed), ask the server for the global Top 10, and cache it.
   * Safe to call from the landing page before joining a room.
   */
  async refreshTop10(): Promise<Top10Entry[]> {
    this.loadingSubject.next(true);
    try {
      await this.ws.connect();
      this.ws.send('GET_TOP10', {});
      const payload = await firstValueFrom(
        this.ws.onAction<{ entries: Top10Entry[] }>('TOP10').pipe(timeout(8000))
      );
      const entries = Array.isArray(payload?.entries) ? payload.entries : [];
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
