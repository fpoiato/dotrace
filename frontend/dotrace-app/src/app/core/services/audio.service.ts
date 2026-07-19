import { Injectable } from '@angular/core';

/**
 * Synthesized victory fanfare (no external asset).
 * Browsers require a user gesture before AudioContext can start — call
 * {@link unlock} from a tap/click (e.g. the gear pad) so play() is not blocked.
 */
@Injectable({ providedIn: 'root' })
export class AudioService {
  private ctx: AudioContext | null = null;
  private playing = false;

  /** Resume/create the AudioContext after a user gesture. */
  unlock(): void {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {
        // Autoplay policy / missing gesture — ignore.
      });
    }
  }

  /** Triumphant short anthem when the winner crosses the finish line. */
  playVictoryAnthem(): void {
    if (this.playing) return;
    if (typeof window === 'undefined') return;

    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      void ctx.resume().then(() => this.startVictoryFanfare(ctx)).catch(() => {
        // Still blocked — nothing we can do without another gesture.
      });
      return;
    }
    this.startVictoryFanfare(ctx);
  }

  stop(): void {
    this.playing = false;
    // Soft stop: closing the context kills any ringing oscillators.
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
  }

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
    }
    return this.ctx;
  }

  private startVictoryFanfare(ctx: AudioContext): void {
    this.playing = true;
    const t0 = ctx.currentTime;

    // Melody (Hz): a bright major fanfare over ~3.2s.
    const melody: Array<{ freq: number; start: number; dur: number; gain: number }> = [
      { freq: 523.25, start: 0.0, dur: 0.22, gain: 0.18 }, // C5
      { freq: 659.25, start: 0.22, dur: 0.22, gain: 0.18 }, // E5
      { freq: 783.99, start: 0.44, dur: 0.28, gain: 0.2 }, // G5
      { freq: 1046.5, start: 0.72, dur: 0.45, gain: 0.22 }, // C6
      { freq: 783.99, start: 1.2, dur: 0.18, gain: 0.16 }, // G5
      { freq: 880.0, start: 1.38, dur: 0.18, gain: 0.16 }, // A5
      { freq: 987.77, start: 1.56, dur: 0.18, gain: 0.18 }, // B5
      { freq: 1046.5, start: 1.74, dur: 0.55, gain: 0.24 }, // C6
      { freq: 1318.5, start: 2.35, dur: 0.7, gain: 0.2 }, // E6 hold
    ];

    // Supporting fifth/octave harmony on the long notes.
    const harmony: Array<{ freq: number; start: number; dur: number; gain: number }> = [
      { freq: 392.0, start: 0.0, dur: 0.72, gain: 0.08 }, // G4
      { freq: 523.25, start: 0.72, dur: 0.45, gain: 0.1 }, // C5
      { freq: 523.25, start: 1.74, dur: 0.55, gain: 0.1 }, // C5
      { freq: 659.25, start: 2.35, dur: 0.7, gain: 0.09 }, // E5
      { freq: 261.63, start: 2.35, dur: 0.7, gain: 0.07 }, // C4 bass
    ];

    for (const note of [...melody, ...harmony]) {
      this.playTone(ctx, t0 + note.start, note.freq, note.dur, note.gain);
    }

    const totalMs = 3200;
    window.setTimeout(() => {
      this.playing = false;
    }, totalMs + 100);
  }

  private playTone(
    ctx: AudioContext,
    start: number,
    freq: number,
    duration: number,
    peakGain: number
  ): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, start);

    // Soft attack / release so it doesn't click.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peakGain, start + 0.03);
    gain.gain.exponentialRampToValueAtTime(peakGain * 0.7, start + duration * 0.55);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }
}
