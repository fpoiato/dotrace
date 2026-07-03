import { Injectable } from '@angular/core';

export interface SessionData {
  roomCode?: string;
  nickname?: string;
  isHost?: boolean;
  connectionId?: string;
  screen?: 'lobby' | 'game';
  trackId?: string;
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
