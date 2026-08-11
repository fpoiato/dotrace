import { Injectable } from '@angular/core';

/**
 * Only user preferences are persisted. Room identity (room code,
 * connection id, host flag) deliberately lives in memory alone — persisting
 * it caused fresh visits to get pulled back into stale rooms.
 */
export interface SessionData {
  nickname?: string;
  trackId?: string;
  laps?: number;
  gameMode?: 'TURNS' | 'TIMED';
  /** Computer opponents the host wants in the next race. */
  botCount?: number;
}

const KEY = 'dotrace-session';

@Injectable({ providedIn: 'root' })
export class SessionStorageService {
  save(partial: SessionData): void {
    const current = this.load() ?? {};
    sessionStorage.setItem(KEY, JSON.stringify({ ...current, ...partial }));
  }

  load(): SessionData | null {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionData;
    } catch {
      return null;
    }
  }

  clear(): void {
    sessionStorage.removeItem(KEY);
  }
}
