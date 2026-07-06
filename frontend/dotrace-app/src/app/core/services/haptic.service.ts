import { Injectable } from '@angular/core';

/** Short kerb-style buzz pattern (ms). */
const RUMBLE_PATTERN = [12, 8, 12, 8, 12] as const;

@Injectable({ providedIn: 'root' })
export class HapticService {
  /** Phone vibration when the car hits rumble strips (no-op if unsupported). */
  rumbleStrip(): void {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') {
      return;
    }
    try {
      navigator.vibrate([...RUMBLE_PATTERN]);
    } catch {
      // Some browsers expose vibrate but reject calls outside a user gesture.
    }
  }
}
