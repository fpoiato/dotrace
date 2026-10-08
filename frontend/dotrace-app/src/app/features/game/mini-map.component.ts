import {
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { PAPER_COLORS, getTrackById } from '../../core/models/tracks';
import { GameState, TrackDefinition, isDrsAsphalt } from '../../core/models/ws-types';

/** Internal pixels per cell for the minimap raster. */
const S = 4;

/**
 * Racing-game style minimap: dark backdrop, the track as a light ribbon,
 * the finish stripe in orange, thin pen trails and a dot per car (the
 * active car gets a white ring).
 */
@Component({
  selector: 'app-mini-map',
  standalone: true,
  template: `<canvas
    #canvas
    class="mx-auto block max-w-full rounded-lg border border-slate-700/70 opacity-95"
    [class.w-full]="compact"
    [class.w-48]="!compact"
  ></canvas>`,
  styles: [
    `
      :host {
        display: block;
      }
      canvas {
        image-rendering: auto;
      }
    `,
  ],
})
export class MiniMapComponent implements OnChanges, OnDestroy {
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @Input() state: GameState | null = null;
  /** Scale to the parent width (used when the map floats over the track). */
  @Input() compact = false;

  /** Redraws while a blue boost ring is blinking. */
  private pulsing = false;
  private pulseFrame = 0;
  private lastPulseDraw = 0;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['state']) {
      requestAnimationFrame(() => this.draw());
    }
  }

  ngOnDestroy(): void {
    this.pulsing = false;
    cancelAnimationFrame(this.pulseFrame);
  }

  private draw(): void {
    const canvas = this.canvasRef.nativeElement;
    const ctx = canvas.getContext('2d');
    const state = this.state;
    if (!ctx || !state?.trackId) return;

    const track = getTrackById(state.trackId);
    if (!track) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const s = S * dpr;
    canvas.width = track.width * s;
    canvas.height = track.height * s;

    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    this.drawRibbon(ctx, track, s);
    this.drawTrails(ctx, state, s);
    const boosted = this.drawCars(ctx, state, s);
    this.syncBoostPulse(boosted);
  }

  private syncBoostPulse(active: boolean): void {
    if (active && !this.pulsing) {
      this.pulsing = true;
      const loop = (now: number) => {
        if (!this.pulsing) return;
        this.pulseFrame = requestAnimationFrame(loop);
        if (now - this.lastPulseDraw < 50) return;
        this.lastPulseDraw = now;
        this.draw();
      };
      this.pulseFrame = requestAnimationFrame(loop);
    } else if (!active && this.pulsing) {
      this.pulsing = false;
      cancelAnimationFrame(this.pulseFrame);
    }
  }

  /** Asphalt cell inside a DRS zone. Grass is never tinted. */
  private inDrsZone(track: TrackDefinition, x: number, y: number): boolean {
    return isDrsAsphalt(track, x, y);
  }

  private drawRibbon(ctx: CanvasRenderingContext2D, track: TrackDefinition, s: number): void {
    for (let y = 0; y < track.height; y++) {
      for (let x = 0; x < track.width; x++) {
        const tile = track.grid[y][x];
        if (tile === 'track') {
          ctx.fillStyle = this.inDrsZone(track, x, y) ? '#60a5fa' : '#cbd5e1';
          ctx.fillRect(x * s, y * s, s, s);
        } else if (tile === 'finish') {
          ctx.fillStyle = (x + y) % 2 === 0 ? PAPER_COLORS.finishDark : '#ffffff';
          ctx.fillRect(x * s, y * s, s, s);
        } else if (tile === 'pit' || tile === 'pitbox') {
          ctx.fillStyle = tile === 'pitbox' ? '#f59e0b' : '#64748b';
          ctx.fillRect(x * s, y * s, s, s);
        }
      }
    }

    // Full zebra outline on every track/off-track edge.
    const isRoad = (x: number, y: number): boolean => {
      const t = track.grid[y]?.[x];
      return t === 'track' || t === 'finish';
    };
    const isOff = (x: number, y: number): boolean => !isRoad(x, y);
    ctx.lineWidth = Math.max(1, s * 0.35);
    ctx.lineCap = 'butt';
    for (let y = 0; y < track.height; y++) {
      for (let x = 0; x < track.width; x++) {
        if (!isRoad(x, y)) continue;
        const edges: Array<[number, number, number, number]> = [];
        if (isOff(x, y - 1)) edges.push([x * s, y * s, (x + 1) * s, y * s]);
        if (isOff(x, y + 1)) edges.push([x * s, (y + 1) * s, (x + 1) * s, (y + 1) * s]);
        if (isOff(x - 1, y)) edges.push([x * s, y * s, x * s, (y + 1) * s]);
        if (isOff(x + 1, y)) edges.push([(x + 1) * s, y * s, (x + 1) * s, (y + 1) * s]);
        for (const [x0, y0, x1, y1] of edges) {
          const dx = x1 - x0;
          const dy = y1 - y0;
          const len = Math.hypot(dx, dy);
          const segs = Math.max(2, Math.ceil(len / Math.max(1, s / 2)));
          for (let i = 0; i < segs; i++) {
            ctx.strokeStyle = i % 2 === 0 ? PAPER_COLORS.rumbleRed : PAPER_COLORS.rumbleWhite;
            const t0 = i / segs;
            const t1 = (i + 1) / segs;
            ctx.beginPath();
            ctx.moveTo(x0 + dx * t0, y0 + dy * t0);
            ctx.lineTo(x0 + dx * t1, y0 + dy * t1);
            ctx.stroke();
          }
        }
      }
    }
  }

  private drawTrails(ctx: CanvasRenderingContext2D, state: GameState, s: number): void {
    for (const player of state.players) {
      const trail = player.trail ?? [];
      if (trail.length < 2) continue;
      ctx.strokeStyle = player.color;
      ctx.lineWidth = Math.max(1, s / 3);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(trail[0].x * s + s / 2, trail[0].y * s + s / 2);
      for (let i = 1; i < trail.length; i++) {
        ctx.lineTo(trail[i].x * s + s / 2, trail[i].y * s + s / 2);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  private drawCars(ctx: CanvasRenderingContext2D, state: GameState, s: number): boolean {
    const activeId =
      state.phase === 'GAME_ROUND' ? state.turnOrder[state.currentTurnIndex] : null;
    const alpha = performance.now() % 640 < 352 ? 0.95 : 0.18;
    let anyBoost = false;
    for (const player of state.players) {
      if (player.finishOrder !== undefined && state.phase !== 'GAME_OVER') continue;
      const cx = player.position.x * s + s / 2;
      const cy = player.position.y * s + s / 2;
      const boosted = !!player.drsActive || !!player.ersActive;
      if (boosted) anyBoost = true;

      if (boosted) {
        ctx.beginPath();
        ctx.arc(cx, cy, s * 2.4, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(34, 211, 238, ${alpha})`;
        ctx.lineWidth = Math.max(1.5, s / 2);
        ctx.stroke();
      }

      if (player.connectionId === activeId) {
        ctx.beginPath();
        ctx.arc(cx, cy, boosted ? s * 2 : s * 1.6, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(1, s / 3);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(cx, cy, boosted ? s * 1.55 : s * 1.1, 0, Math.PI * 2);
      ctx.fillStyle = player.color;
      ctx.fill();
      ctx.strokeStyle = '#0b1220';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    return anyBoost;
  }
}
