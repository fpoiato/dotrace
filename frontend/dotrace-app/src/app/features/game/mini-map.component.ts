import {
  Component,
  ElementRef,
  Input,
  OnChanges,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { PAPER_COLORS, getTrackById } from '../../core/models/tracks';
import { GameState, TrackDefinition } from '../../core/models/ws-types';

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
    class="mx-auto block w-48 rounded-lg border border-slate-700/70 opacity-95"
  ></canvas>`,
  styles: [
    `
      canvas {
        image-rendering: auto;
      }
    `,
  ],
})
export class MiniMapComponent implements OnChanges {
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @Input() state: GameState | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['state']) {
      requestAnimationFrame(() => this.draw());
    }
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
    this.drawCars(ctx, state, s);
  }

  private drawRibbon(ctx: CanvasRenderingContext2D, track: TrackDefinition, s: number): void {
    for (let y = 0; y < track.height; y++) {
      for (let x = 0; x < track.width; x++) {
        const tile = track.grid[y][x];
        if (tile === 'track') {
          ctx.fillStyle = '#cbd5e1';
          ctx.fillRect(x * s, y * s, s, s);
        } else if (tile === 'rumble') {
          ctx.fillStyle = PAPER_COLORS.rumbleRed;
          ctx.fillRect(x * s, y * s, s, s);
        } else if (tile === 'finish') {
          ctx.fillStyle = PAPER_COLORS.finish;
          ctx.fillRect(x * s, y * s, s, s);
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

  private drawCars(ctx: CanvasRenderingContext2D, state: GameState, s: number): void {
    const activeId =
      state.phase === 'GAME_ROUND' ? state.turnOrder[state.currentTurnIndex] : null;
    for (const player of state.players) {
      if (player.finishOrder !== undefined && state.phase !== 'GAME_OVER') continue;
      const cx = player.position.x * s + s / 2;
      const cy = player.position.y * s + s / 2;

      if (player.connectionId === activeId) {
        ctx.beginPath();
        ctx.arc(cx, cy, s * 1.6, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(1, s / 3);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(cx, cy, s * 1.1, 0, Math.PI * 2);
      ctx.fillStyle = player.color;
      ctx.fill();
      ctx.strokeStyle = '#0b1220';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}
