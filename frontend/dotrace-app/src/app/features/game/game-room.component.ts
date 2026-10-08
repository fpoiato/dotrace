import { AsyncPipe } from '@angular/common';
import { ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { getTrackById } from '../../core/models/tracks';
import {
  GameState,
  TrackDefinition,
  LiveStandingRow,
  Player,
  Vector2D,
  BoostRequest,
  buildLiveStandings,
  boostLimits,
  canPlayerMove,
  formatRaceTime,
  getTileAt,
  ERS_MAX_DELTA,
  getValidMoves,
  isErsOppositeStep,
  isGearLimited,
  isGrassShortcut,
  isAiPilotNickname,
  isKerbGrass,
  segmentTouchesKerb,
  landingPosition,
  remainingStopMs,
  segmentCrossesRumble,
} from '../../core/models/ws-types';
import { AudioService } from '../../core/services/audio.service';
import { GameEngineService } from '../../core/services/game-engine.service';
import { HapticService } from '../../core/services/haptic.service';
import { RoomService } from '../../core/services/room.service';
import { TelemetryService } from '../../core/services/telemetry.service';
import { WebSocketService } from '../../core/services/websocket.service';
import { LoadingSpinnerComponent } from '../../shared/loading-spinner.component';
import { LeaderboardComponent } from './leaderboard.component';
import { MiniMapComponent } from './mini-map.component';
import { ReplayViewerComponent } from './replay-viewer.component';
import { newPenaltyFlags, PenaltyMark } from './penalty-flag';
import { TrackCanvasComponent } from './track-canvas.component';

/** Amber on the pad: a real grass cut, or a landing that leaves the asphalt. */
function moveWarnsOffAsphalt(
  track: TrackDefinition,
  from: Vector2D,
  landing: Vector2D
): boolean {
  const tile = getTileAt(track, landing.x, landing.y);
  return (
    isGrassShortcut(track, from, landing) ||
    tile === 'rumble' ||
    isKerbGrass(track, landing.x, landing.y)
  );
}

interface PadOption {
  key: string;
  glyph: string;
  enabled: boolean;
  velocity: Vector2D | null;
  /** Real grass cut, or a landing that leaves the asphalt. */
  grass: boolean;
}

const PAD_GLYPHS: Record<string, string> = {
  '-1,-1': '↖',
  '0,-1': '↑',
  '1,-1': '↗',
  '-1,0': '←',
  '0,0': '●',
  '1,0': '→',
  '-1,1': '↙',
  '0,1': '↓',
  '1,1': '↘',
};

@Component({
  selector: 'app-game-room',
  standalone: true,
  imports: [AsyncPipe, TranslateModule, TrackCanvasComponent, MiniMapComponent, LoadingSpinnerComponent, LeaderboardComponent, ReplayViewerComponent],
  templateUrl: './game-room.component.html',
  styles: [
    `
      @media (max-height: 520px) {
        .race-screen {
          max-width: none;
        }
        .race-body {
          flex-direction: row;
          align-items: stretch;
          gap: 0.5rem;
        }
        .race-controls {
          display: flex;
          width: 11.5rem;
          min-height: 0;
          margin-top: 0;
          flex-direction: column;
          justify-content: flex-end;
        }
        .race-hint,
        .race-standings {
          display: none;
        }
        .race-pad {
          width: 100%;
          max-width: none;
          margin: 0;
        }
      }
      .penalty-flag {
        background: linear-gradient(135deg, #0a0a0a 50%, #f8fafc 50%);
        box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.55);
      }
      .penalty-chip {
        animation: penalty-chip-in 160ms ease-out;
      }
      @keyframes penalty-chip-in {
        from {
          opacity: 0;
          transform: translateY(-4px);
        }
        to {
          opacity: 1;
          transform: none;
        }
      }
    `,
  ],
})
export class GameRoomComponent implements OnInit, OnDestroy {
  readonly game = inject(GameEngineService);
  readonly telemetry = inject(TelemetryService);
  private readonly haptic = inject(HapticService);
  private readonly audio = inject(AudioService);
  private readonly room = inject(RoomService);
  private readonly ws = inject(WebSocketService);
  private readonly router = inject(Router);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly state$ = this.game.state$;
  readonly roomCtx$ = this.room.room$;
  readonly formatRaceTime = formatRaceTime;
  private readonly subs: Subscription[] = [];

  showCelebration = false;
  showReplay = false;
  padOptions: PadOption[] = [];
  /** Next SUBMIT_MOVE asks the host to open DRS. Does not spend the turn. */
  drsIntent = false;
  /** Next SUBMIT_MOVE spends one ERS bar. */
  ersIntent = false;
  readonly ersPips = [0, 1, 2, 3];
  readonly fuelPips = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  private boostStamp = '';
  /** Seconds left on a timed grass penalty (drives the popup countdown). */
  penaltyCountdownSec = 0;
  /** Recent grass penalties, newest first. Shown to every client. */
  penaltyFlags: { id: number; nickname: string; color: string }[] = [];
  private penaltyCuts: Map<string, PenaltyMark> | null = null;
  private penaltyFlagSeq = 0;
  private readonly penaltyFlagTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private static readonly PENALTY_FLAG_MS = 7000;
  /** Tick every 250ms while a timed stop penalty is active. */
  private stopPenaltyTimer: ReturnType<typeof setInterval> | null = null;
  /** One-shot so reconnect/replay emissions don't restart the anthem. */
  private victoryAnthemPlayed = false;
  /** Removes the one-shot gesture listener used to unlock AudioContext. */
  private removeAudioUnlock: (() => void) | null = null;

  ngOnInit(): void {
    if (!this.room.room) {
      void this.router.navigate(['/']);
      return;
    }
    this.game.init();
    this.telemetry.init();
    this.game.ensureLobbyState();
    this.armAudioUnlock();

    this.subs.push(
      this.room.listenForLobbyUpdates().subscribe(),
      this.game.state$.subscribe((state) => {
        this.syncBoostIntents(state);
        this.rebuildPad(state);
        this.updatePenaltyCountdown(state);
        this.syncPenaltyFlags(state);
        this.syncStopPenaltyTimer(state);
        this.maybePlayVictoryAnthem(state);
        if (state?.phase === 'GAME_OVER') {
          this.showCelebration = true;
        }
        // Host-migration fallback / play-again can reset the game to the
        // lobby phase; follow it so nobody is stranded on the game screen.
        if (state?.phase === 'LOBBY') {
          this.showCelebration = false;
          this.showReplay = false;
          void this.router.navigate(['/lobby']);
        }
      })
    );
  }

  /**
   * Play the victory anthem the first time someone reaches the podium
   * (winner crossing the finish line). Resets when a new race starts.
   */
  private maybePlayVictoryAnthem(state: GameState | null): void {
    if (!state || state.phase === 'LOBBY' || (state.phase === 'GAME_ROUND' && state.podium.length === 0)) {
      this.victoryAnthemPlayed = false;
      return;
    }
    if (state.podium.length > 0 && !this.victoryAnthemPlayed) {
      this.victoryAnthemPlayed = true;
      this.audio.playVictoryAnthem();
    }
  }

  /**
   * The 3×3 gear pad. Each arrow is ±1 on an axis (center = coast).
   * With ERS held, the same nine arrows step by 2. The three that point
   * only against travel stay on the pad and are disabled.
   * Buttons light up only for moves the host would accept, and turn amber off the asphalt.
   */
  private buildPadOptions(state: GameState | null): PadOption[] {
    const options: PadOption[] = [];
    const myId = this.room.room?.connectionId;
    const track = state?.trackId ? getTrackById(state.trackId) : undefined;
    const me = state?.players.find((p) => p.connectionId === myId);
    const canMove =
      !!state && !!myId && canPlayerMove(state, myId) && me?.finishOrder === undefined;
    const ersOn = !!(state && me && this.boostRequest(state, me).ers);
    const step = ersOn ? ERS_MAX_DELTA : 1;

    const valid =
      canMove && me && track
        ? getValidMoves(
            me,
            track,
            state?.players,
            state?.round ?? 1,
            ...this.moveCaps(state, me)
          )
        : [];

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = `${dx},${dy}`;
        const delta = { x: dx * step, y: dy * step };
        const opposite = !!(ersOn && me && isErsOppositeStep(me.velocity, delta));
        let velocity: Vector2D | null = null;
        let grass = false;
        if (me && track && !opposite) {
          const v = { x: me.velocity.x + delta.x, y: me.velocity.y + delta.y };
          const match = valid.find((m) => m.velocity.x === v.x && m.velocity.y === v.y);
          if (match) {
            velocity = match.velocity;
            const landing = landingPosition(me.position, match.velocity);
            grass = moveWarnsOffAsphalt(track, me.position, landing);
          }
        }
        options.push({ key, glyph: PAD_GLYPHS[key], enabled: velocity !== null, velocity, grass });
      }
    }

    // Boxed-in at speed: the only legal move is the emergency stop, which is
    // outside the ±1 pad — surface it on the center button.
    if (options.every((o) => !o.enabled) && me && track) {
      const stop = valid.find((m) => m.velocity.x === 0 && m.velocity.y === 0);
      const dx = stop ? stop.velocity.x - me.velocity.x : 0;
      const dy = stop ? stop.velocity.y - me.velocity.y : 0;
      if (stop && (Math.abs(dx) > step || Math.abs(dy) > step)) {
        const centerIdx = options.findIndex((o) => o.key === '0,0');
        const landing = landingPosition(me.position, stop.velocity);
        options[centerIdx] = {
          key: '0,0',
          glyph: '■',
          enabled: true,
          velocity: stop.velocity,
          grass: moveWarnsOffAsphalt(track, me.position, landing),
        };
      }
    }

    return options;
  }

  /** Ceiling and delta the host would use for the buttons currently held. */
  private moveCaps(state: GameState, me: Player): [number, number] {
    const limits = boostLimits(me, state.round, this.boostRequest(state, me));
    return [limits.maxGear, limits.maxDelta];
  }

  private boostRequest(state: GameState, me: Player): BoostRequest {
    return {
      drs: this.drsIntent && this.drsButtonEnabled(state, me),
      ers: this.ersIntent && this.ersButtonEnabled(state, me),
    };
  }

  /**
   * Drop the held buttons when the car actually moves (or the turn changes).
   * Toggling a button does not change this stamp.
   */
  private syncBoostIntents(state: GameState | null): void {
    const me = state ? this.myPlayer(state) : undefined;
    const stamp = [
      state?.phase,
      state?.round,
      state?.currentTurnIndex,
      me?.position.x,
      me?.position.y,
      me?.velocity.x,
      me?.velocity.y,
      me?.lap,
    ].join(':');
    if (stamp === this.boostStamp) return;
    this.boostStamp = stamp;
    this.drsIntent = false;
    this.ersIntent = false;
  }

  private rebuildPad(state: GameState | null): void {
    this.padOptions = this.buildPadOptions(state);
  }

  drsButtonEnabled(state: GameState, me: Player): boolean {
    return (
      this.game.isMyTurn() && !!me.drsArmed && !me.drsActive && !isGearLimited(me, state.round)
    );
  }

  ersButtonEnabled(state: GameState, me: Player): boolean {
    return this.game.isMyTurn() && (me.ersCharge ?? 0) >= 1 && !isGearLimited(me, state.round);
  }

  toggleDrs(state: GameState, me: Player): void {
    if (!this.drsButtonEnabled(state, me)) return;
    this.drsIntent = !this.drsIntent;
    this.rebuildPad(state);
  }

  toggleErs(state: GameState, me: Player): void {
    if (!this.ersButtonEnabled(state, me) && !this.ersIntent) return;
    this.ersIntent = !this.ersIntent;
    this.rebuildPad(state);
  }

  /** 0, 0.25, 0.5, 0.75 or 1 for pip `index` (0 = first bar). */
  ersPipFill(me: Player, index: number): number {
    const charge = me.ersCharge ?? 0;
    const full = Math.floor(charge);
    if (index < full) return 1;
    if (index > full) return 0;
    return charge - full;
  }

  fuelPipFill(me: Player, index: number): number {
    const fuel = me.fuel ?? 0;
    const slice = fuel - index * 10;
    return Math.max(0, Math.min(1, slice / 10));
  }

  pad(option: PadOption): void {
    if (!option.enabled || !option.velocity) return;

    // Unlock AudioContext on the move gesture so the victory anthem can play later.
    this.audio.unlock();

    const state = this.game.state;
    const me = state ? this.myPlayer(state) : undefined;
    const track = state?.trackId ? getTrackById(state.trackId) : undefined;
    if (me && track) {
      const landing = landingPosition(me.position, option.velocity);
      if (isGrassShortcut(track, me.position, landing)) {
        this.haptic.grassHit();
      } else if (
        getTileAt(track, landing.x, landing.y) === 'rumble' ||
        isKerbGrass(track, landing.x, landing.y) ||
        segmentCrossesRumble(track, me.position, landing) ||
        segmentTouchesKerb(track, me.position, landing)
      ) {
        this.haptic.rumbleStrip();
      }
    }

    const request = me && state ? this.boostRequest(state, me) : undefined;
    this.game.submitMove(option.velocity, request);
  }

  ngOnDestroy(): void {
    this.clearPenaltyFlags();
    this.clearStopPenaltyTimer();
    this.removeAudioUnlock?.();
    this.removeAudioUnlock = null;
    this.audio.stop();
    this.subs.forEach((s) => s.unsubscribe());
  }

  /** Any tap/click on the race screen unlocks Web Audio for the victory anthem. */
  private armAudioUnlock(): void {
    if (typeof window === 'undefined') return;
    const unlock = () => {
      this.audio.unlock();
      this.removeAudioUnlock?.();
      this.removeAudioUnlock = null;
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    this.removeAudioUnlock = () => window.removeEventListener('pointerdown', unlock);
  }

  currentPlayerName(): string {
    return this.game.currentPlayer()?.nickname ?? '…';
  }

  myPlayer(state: GameState): Player | undefined {
    const id = this.room.room?.connectionId;
    return state.players.find((p) => p.connectionId === id);
  }

  /** Race order for the in-race classification panel (color + position). */
  liveStandings(state: GameState): LiveStandingRow[] {
    const track = state.trackId ? getTrackById(state.trackId) : undefined;
    return buildLiveStandings(state, track);
  }

  /** TURNS mode: gear-1 cap from a grass penalty (not just standing on grass). */
  hasGearPenalty(state: GameState, player: Player): boolean {
    return isGearLimited(player, state.round) && !player.isOffTrack;
  }

  /** Seconds left on a timed stop penalty (0 if none). */
  stopPenaltySec(player: Player): number {
    return Math.ceil(remainingStopMs(player) / 1000);
  }

  /**
   * Black-and-white flag when anyone takes a grass penalty.
   * A lobby reset clears the baseline. Leaving the round (podium) leaves the
   * chip up until its timer, so the last cut of a race is still visible.
   */
  private syncPenaltyFlags(state: GameState | null): void {
    if (!state || state.phase === 'LOBBY') {
      this.clearPenaltyFlags();
      return;
    }
    if (state.phase !== 'GAME_ROUND') return;
    const { baseline, notices } = newPenaltyFlags(this.penaltyCuts, state.players);
    this.penaltyCuts = baseline;
    if (notices.length === 0) return;
    for (const notice of notices) this.pushPenaltyFlag(notice.nickname, notice.color);
    this.cdr.markForCheck();
  }

  private pushPenaltyFlag(nickname: string, color: string): void {
    const id = ++this.penaltyFlagSeq;
    const next = [{ id, nickname, color }, ...this.penaltyFlags].slice(0, 3);
    const kept = new Set(next.map((flag) => flag.id));
    for (const [flagId, timer] of this.penaltyFlagTimers) {
      if (!kept.has(flagId)) {
        clearTimeout(timer);
        this.penaltyFlagTimers.delete(flagId);
      }
    }
    this.penaltyFlags = next;
    this.penaltyFlagTimers.set(
      id,
      setTimeout(() => this.dismissPenaltyFlag(id), GameRoomComponent.PENALTY_FLAG_MS)
    );
  }

  private dismissPenaltyFlag(id: number): void {
    const timer = this.penaltyFlagTimers.get(id);
    if (timer) clearTimeout(timer);
    this.penaltyFlagTimers.delete(id);
    this.penaltyFlags = this.penaltyFlags.filter((flag) => flag.id !== id);
  }

  private clearPenaltyFlags(): void {
    for (const timer of this.penaltyFlagTimers.values()) clearTimeout(timer);
    this.penaltyFlagTimers.clear();
    this.penaltyFlags = [];
    this.penaltyCuts = null;
  }

  private updatePenaltyCountdown(state: GameState | null): void {
    if (!state || state.gameMode !== 'TIMED' || state.phase !== 'GAME_ROUND') {
      this.penaltyCountdownSec = 0;
      return;
    }
    const me = this.myPlayer(state);
    this.penaltyCountdownSec = me ? this.stopPenaltySec(me) : 0;
  }

  private syncStopPenaltyTimer(state: GameState | null): void {
    const me = state && this.room.room
      ? state.players.find((p) => p.connectionId === this.room.room!.connectionId)
      : undefined;
    const active = !!me && remainingStopMs(me) > 0;
    if (active && !this.stopPenaltyTimer) {
      this.stopPenaltyTimer = setInterval(() => {
        const s = this.game.state;
        const id = this.room.room?.connectionId;
        const p = s?.players.find((pl) => pl.connectionId === id);
        this.rebuildPad(s);
        this.updatePenaltyCountdown(s);
        if (!p || remainingStopMs(p) <= 0) {
          this.clearStopPenaltyTimer();
        }
      }, 250);
    } else if (!active) {
      this.clearStopPenaltyTimer();
    }
  }

  private clearStopPenaltyTimer(): void {
    if (this.stopPenaltyTimer) {
      clearInterval(this.stopPenaltyTimer);
      this.stopPenaltyTimer = null;
    }
    this.penaltyCountdownSec = 0;
  }

  openReplay(): void {
    this.showReplay = true;
  }

  /** Humans are done and bots are still out. Ending leaves those bots as DNF. */
  canEndNow(state: GameState): boolean {
    if (state.phase !== 'GAME_ROUND') return false;
    const me = this.myPlayer(state);
    if (!me || isAiPilotNickname(me.nickname)) return false;
    const humansOut = state.players.some(
      (p) => !isAiPilotNickname(p.nickname) && p.finishOrder === undefined
    );
    const botsOut = state.players.some(
      (p) => isAiPilotNickname(p.nickname) && p.finishOrder === undefined
    );
    return !humansOut && botsOut;
  }

  endRaceNow(): void {
    this.game.endRaceNow();
  }

  closeReplay(): void {
    this.showReplay = false;
  }

  playAgain(): void {
    this.showCelebration = false;
    this.showReplay = false;
    this.game.returnToLobby();
  }

  backToMenu(): void {
    this.showCelebration = false;
    this.showReplay = false;
    this.victoryAnthemPlayed = false;
    this.audio.stop();
    this.game.reset();
    this.room.reset();
    this.ws.disconnect();
    void this.router.navigate(['/']);
  }
}
