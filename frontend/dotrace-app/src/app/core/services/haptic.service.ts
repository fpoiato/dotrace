import { Injectable } from '@angular/core';

/** Short kerb-style buzz pattern (ms). */
const RUMBLE_PATTERN = [12, 8, 12, 8, 12] as const;

/** Stronger buzz when cutting through grass. */
const GRASS_PATTERN = [45, 25, 45, 25, 70] as const;

/** Three distinct buzzes so a stalled human feels "play now". */
const PLAY_NOW_PATTERN = [160, 140, 160, 140, 160] as const;

@Injectable({ providedIn: 'root' })
export class HapticService {
  /** Phone vibration when the car hits rumble strips (no-op if unsupported). */
  rumbleStrip(): void {
    this.vibrate(RUMBLE_PATTERN);
  }

  /** Stronger vibration when the car hits or cuts through grass. */
  grassHit(): void {
    this.vibrate(GRASS_PATTERN);
  }

  /** Three buzzes when it is the human's turn and the clock has gone quiet. */
  playNow(): void {
    this.vibrate(PLAY_NOW_PATTERN);
  }

  private vibrate(pattern: readonly number[]): void {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') {
      return;
    }
    try {
      navigator.vibrate([...pattern]);
    } catch {
      // Some browsers expose vibrate but reject calls outside a user gesture.
    }
  }
}
