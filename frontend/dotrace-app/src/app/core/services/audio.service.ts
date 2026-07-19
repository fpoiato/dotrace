import { Injectable } from '@angular/core';

/**
 * Chiptune-style MIDI player for the finish-line victory theme.
 *
 * Expects a licensed Standard MIDI file at:
 *   `src/assets/audio/tema-da-vitoria.mid`
 *
 * The classic Globo F1 “Tema da Vitória” (Eduardo Souto Neto / Roupa Nova)
 * is copyrighted in every format — MIDI, MP3, or synthesized notes. Do not
 * commit an unlicensed transcription. Drop in a `.mid` you have rights to
 * use and it will play with a VRC7-ish square/triangle voice (similar vibe
 * to 8-bit covers, without bundling that composition).
 *
 * Call {@link unlock} from a user gesture so later playback is not blocked.
 */
@Injectable({ providedIn: 'root' })
export class AudioService {
  private static readonly THEME_SRC = 'assets/audio/tema-da-vitoria.mid';

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private midiBytes: ArrayBuffer | null = null;
  private loadPromise: Promise<ArrayBuffer | null> | null = null;
  private playing = false;
  private stopAt = 0;

  /** Resume/create AudioContext after a tap/click. */
  unlock(): void {
    if (typeof window === 'undefined') return;
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined);
    }
    void this.ensureMidiLoaded();
  }

  /** Play the victory MIDI (chiptune synth). No-op if the file is missing. */
  playVictoryAnthem(): void {
    if (this.playing || typeof window === 'undefined') return;

    const ctx = this.ensureContext();
    const start = () => {
      void this.ensureMidiLoaded().then((buf) => {
        if (!buf || this.playing) return;
        try {
          this.scheduleMidi(buf, ctx);
        } catch {
          this.playing = false;
        }
      });
    };

    if (ctx.state === 'suspended') {
      void ctx.resume().then(start).catch(() => undefined);
      return;
    }
    start();
  }

  stop(): void {
    this.playing = false;
    this.stopAt = 0;
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
      this.master = null;
    }
  }

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.22;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private ensureMidiLoaded(): Promise<ArrayBuffer | null> {
    if (this.midiBytes) return Promise.resolve(this.midiBytes);
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = fetch(AudioService.THEME_SRC)
      .then(async (res) => {
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        // Reject HTML error pages / empty responses masquerading as MIDI.
        if (buf.byteLength < 14) return null;
        const mag = new Uint8Array(buf, 0, 4);
        if (mag[0] !== 0x4d || mag[1] !== 0x54 || mag[2] !== 0x68 || mag[3] !== 0x64) {
          return null; // not "MThd"
        }
        this.midiBytes = buf;
        return buf;
      })
      .catch(() => null);

    return this.loadPromise;
  }

  private scheduleMidi(buf: ArrayBuffer, ctx: AudioContext): void {
    const notes = parseMidiNotes(buf);
    if (notes.length === 0) return;

    const master = this.master;
    if (!master) return;

    this.playing = true;
    const t0 = ctx.currentTime + 0.05;
    let end = t0;

    for (const n of notes) {
      const start = t0 + n.time;
      const dur = Math.max(0.05, n.duration);
      end = Math.max(end, start + dur);
      this.playChipNote(ctx, master, start, midiToHz(n.midi), dur, n.velocity);
    }

    this.stopAt = end;
    const ms = Math.ceil((end - ctx.currentTime) * 1000) + 80;
    window.setTimeout(() => {
      if (this.stopAt === end) this.playing = false;
    }, ms);
  }

  /** Soft square+triangle stack — closer to VRC7/chiptune than a sine beep. */
  private playChipNote(
    ctx: AudioContext,
    dest: AudioNode,
    start: number,
    freq: number,
    duration: number,
    velocity: number
  ): void {
    const peak = 0.08 + (velocity / 127) * 0.14;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + 0.012);
    g.gain.exponentialRampToValueAtTime(peak * 0.55, start + duration * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    g.connect(dest);

    const square = ctx.createOscillator();
    square.type = 'square';
    square.frequency.setValueAtTime(freq, start);
    square.connect(g);
    square.start(start);
    square.stop(start + duration + 0.02);

    const tri = ctx.createOscillator();
    tri.type = 'triangle';
    tri.frequency.setValueAtTime(freq, start);
    const triGain = ctx.createGain();
    triGain.gain.value = 0.45;
    tri.connect(triGain);
    triGain.connect(g);
    tri.start(start);
    tri.stop(start + duration + 0.02);
  }
}

interface MidiNote {
  midi: number;
  time: number; // seconds from start
  duration: number;
  velocity: number;
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Minimal SMF (format 0/1) parser → note list with wall-clock times. */
function parseMidiNotes(buf: ArrayBuffer): MidiNote[] {
  const data = new Uint8Array(buf);
  let i = 0;

  const readStr = (n: number) => {
    const s = String.fromCharCode(...data.subarray(i, i + n));
    i += n;
    return s;
  };
  const readU16 = () => {
    const v = (data[i] << 8) | data[i + 1];
    i += 2;
    return v;
  };
  const readU32 = () => {
    const v = (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3];
    i += 4;
    return v >>> 0;
  };
  const readVlq = () => {
    let v = 0;
    for (;;) {
      const b = data[i++];
      v = (v << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return v;
    }
  };

  if (readStr(4) !== 'MThd') return [];
  const hdrLen = readU32();
  const format = readU16();
  const nTracks = readU16();
  const division = readU16();
  i += Math.max(0, hdrLen - 6);
  void format;

  if (division & 0x8000) {
    // SMPTE time division — uncommon; skip unsupported files.
    return [];
  }
  const ppqn = division || 480;

  interface RawEvent {
    tick: number;
    type: 'on' | 'off' | 'tempo';
    midi?: number;
    vel?: number;
    usPerBeat?: number;
  }

  const events: RawEvent[] = [];

  for (let t = 0; t < nTracks; t++) {
    if (i + 8 > data.length) break;
    if (readStr(4) !== 'MTrk') break;
    const trackLen = readU32();
    const trackEnd = i + trackLen;
    let tick = 0;
    let running = 0;

    while (i < trackEnd && i < data.length) {
      tick += readVlq();
      let status = data[i];
      if (status < 0x80) {
        status = running;
      } else {
        i++;
        running = status;
      }

      const high = status & 0xf0;
      if (high === 0x90 || high === 0x80) {
        const note = data[i++];
        const vel = data[i++];
        if (high === 0x90 && vel > 0) {
          events.push({ tick, type: 'on', midi: note, vel });
        } else {
          events.push({ tick, type: 'off', midi: note, vel: 0 });
        }
      } else if (high === 0xa0 || high === 0xb0 || high === 0xe0) {
        i += 2;
      } else if (high === 0xc0 || high === 0xd0) {
        i += 1;
      } else if (status === 0xff) {
        const meta = data[i++];
        const len = readVlq();
        if (meta === 0x51 && len === 3) {
          const us = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
          events.push({ tick, type: 'tempo', usPerBeat: us });
        }
        i += len;
      } else if (status === 0xf0 || status === 0xf7) {
        const len = readVlq();
        i += len;
      } else {
        break;
      }
    }
    i = trackEnd;
  }

  events.sort((a, b) => a.tick - b.tick || (a.type === 'off' ? -1 : 1));

  let usPerBeat = 500_000; // 120 BPM default
  let lastTick = 0;
  let seconds = 0;
  const open = new Map<number, { time: number; vel: number }>();
  const notes: MidiNote[] = [];

  const advance = (toTick: number) => {
    const dt = toTick - lastTick;
    seconds += (dt * usPerBeat) / ppqn / 1_000_000;
    lastTick = toTick;
  };

  for (const ev of events) {
    advance(ev.tick);
    if (ev.type === 'tempo' && ev.usPerBeat) {
      usPerBeat = ev.usPerBeat;
    } else if (ev.type === 'on' && ev.midi !== undefined) {
      open.set(ev.midi, { time: seconds, vel: ev.vel ?? 80 });
    } else if (ev.type === 'off' && ev.midi !== undefined) {
      const start = open.get(ev.midi);
      if (start) {
        notes.push({
          midi: ev.midi,
          time: start.time,
          duration: Math.max(0.05, seconds - start.time),
          velocity: start.vel,
        });
        open.delete(ev.midi);
      }
    }
  }

  // Close notes still held at end of file.
  for (const [midi, start] of open) {
    notes.push({
      midi,
      time: start.time,
      duration: 0.3,
      velocity: start.vel,
    });
  }

  return notes;
}
