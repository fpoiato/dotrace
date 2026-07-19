import { Injectable } from '@angular/core';

/**
 * Plays the victory theme when the winner crosses the finish line.
 *
 * Expects a licensed audio file at:
 *   `src/assets/audio/tema-da-vitoria.mp3`
 *
 * The classic Globo F1 “Tema da Vitória” (Eduardo Souto Neto / Roupa Nova)
 * is copyrighted — do not commit an unlicensed copy. Drop in a file you
 * have rights to use (same path/name) and it will play automatically.
 *
 * Browsers require a user gesture before audio can start — call
 * {@link unlock} from a tap/click so {@link playVictoryAnthem} is not blocked.
 */
@Injectable({ providedIn: 'root' })
export class AudioService {
  private static readonly THEME_SRC = 'assets/audio/tema-da-vitoria.mp3';

  private audio: HTMLAudioElement | null = null;
  private unlocked = false;
  private playing = false;

  /** Warm up the audio element after a user gesture (autoplay policy). */
  unlock(): void {
    if (typeof window === 'undefined') return;
    const el = this.ensureAudio();
    if (this.unlocked) return;

    // Muted play/pause is the usual trick to unlock media for later playback.
    const wasMuted = el.muted;
    el.muted = true;
    const p = el.play();
    if (p && typeof p.then === 'function') {
      void p
        .then(() => {
          el.pause();
          el.currentTime = 0;
          el.muted = wasMuted;
          this.unlocked = true;
        })
        .catch(() => {
          el.muted = wasMuted;
        });
    } else {
      el.muted = wasMuted;
    }
  }

  /** Play the Tema da Vitória when the winner finishes (no-op if file missing). */
  playVictoryAnthem(): void {
    if (this.playing || typeof window === 'undefined') return;

    const el = this.ensureAudio();
    try {
      el.currentTime = 0;
    } catch {
      // Ignore if not seekable yet.
    }

    this.playing = true;
    const p = el.play();
    if (p && typeof p.then === 'function') {
      void p
        .then(() => {
          this.unlocked = true;
        })
        .catch(() => {
          // Missing file, decode error, or autoplay still blocked.
          this.playing = false;
        });
    }
  }

  stop(): void {
    this.playing = false;
    if (!this.audio) return;
    try {
      this.audio.pause();
      this.audio.currentTime = 0;
    } catch {
      // Ignore.
    }
  }

  private ensureAudio(): HTMLAudioElement {
    if (this.audio) return this.audio;

    const el = new Audio(AudioService.THEME_SRC);
    el.preload = 'auto';
    el.addEventListener('ended', () => {
      this.playing = false;
    });
    el.addEventListener('error', () => {
      this.playing = false;
    });
    this.audio = el;
    return el;
  }
}
