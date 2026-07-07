import { Injectable } from '@angular/core';

/** Short kerb-style buzz pattern (ms). */
const RUMBLE_PATTERN = [12, 8, 12, 8, 12] as const;

/** Stronger buzz when cutting through grass. */
const GRASS_PATTERN = [45, 25, 45, 25, 70] as const;

/** Heavy impact pattern when two cars collide. */
const CRASH_PATTERN = [90, 40, 90, 40, 120, 50, 90] as const;

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

  /** Heavy vibration when the car crashes into another racer. */
  crash(): void {
    this.vibrate(CRASH_PATTERN);
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
