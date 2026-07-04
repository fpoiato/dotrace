import { Injectable, OnDestroy, inject } from '@angular/core';
import { BehaviorSubject, Subscription } from 'rxjs';
import {
  GameState,
  RaceTelemetrySnapshot,
  buildRaceTelemetry,
} from '../models/ws-types';
import { GameEngineService } from './game-engine.service';

@Injectable({ providedIn: 'root' })
export class TelemetryService implements OnDestroy {
  private readonly game = inject(GameEngineService);

  private readonly elapsedMsSubject = new BehaviorSubject(0);
  readonly elapsedMs$ = this.elapsedMsSubject.asObservable();

  private readonly snapshotSubject = new BehaviorSubject<RaceTelemetrySnapshot | null>(null);
  readonly snapshot$ = this.snapshotSubject.asObservable();

  private stateSub: Subscription | null = null;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private raceStartedAt: number | null = null;

  init(): void {
    if (this.stateSub) return;
    this.stateSub = this.game.state$.subscribe((state) => this.onStateChange(state));
  }

  private onStateChange(state: GameState | null): void {
    if (!state?.raceStartedAt || state.phase === 'LOBBY' || state.phase === 'GRID_ORDER') {
      this.stopTimer();
      this.raceStartedAt = null;
      this.elapsedMsSubject.next(0);
      if (!state || state.phase === 'LOBBY') {
        this.snapshotSubject.next(null);
      }
      return;
    }

    this.raceStartedAt = state.raceStartedAt;
    const snapshot = buildRaceTelemetry(state);
    if (snapshot) {
      this.snapshotSubject.next(snapshot);
      if (this.game.isHost) {
        console.log('[DotRace telemetry]', snapshot);
      }
    }

    if (state.phase === 'GAME_ROUND') {
      this.startTimer(state.raceStartedAt);
    } else if (state.phase === 'GAME_OVER') {
      this.stopTimer();
      this.elapsedMsSubject.next(Date.now() - state.raceStartedAt);
    }
  }

  private startTimer(raceStartedAt: number): void {
    this.updateElapsed(raceStartedAt);
    if (this.timerId) return;
    this.timerId = setInterval(() => {
      if (this.raceStartedAt !== null) {
        this.updateElapsed(this.raceStartedAt);
      }
    }, 1000);
  }

  private updateElapsed(raceStartedAt: number): void {
    this.elapsedMsSubject.next(Math.max(0, Date.now() - raceStartedAt));
  }

  private stopTimer(): void {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  ngOnDestroy(): void {
    this.stateSub?.unsubscribe();
    this.stopTimer();
  }
}
