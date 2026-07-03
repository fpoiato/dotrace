import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnChanges,
  SimpleChanges,
  ViewChild,
  inject,
} from '@angular/core';
import { PAPER_COLORS, getTrackById } from '../../core/models/tracks';
import {
  GameState,
  Player,
  TrackDefinition,
  Vector2D,
  getValidMoves,
} from '../../core/models/ws-types';
import { GameEngineService } from '../../core/services/game-engine.service';
import { RoomService } from '../../core/services/room.service';

/** Internal pixels per grid cell (CSS scales the canvas responsively). */
const CELL = 16;

/**
 * "Pen and paper" renderer: grid paper, green marker for the run-off, thick
 * ink boundaries, an orange start/finish stripe with direction arrows, one
 * colored pen trail per car and highlighted squares the active player can tap.
 */
@Component({
  selector: 'app-track-canvas',
  standalone: true,
  template: `<canvas
    #canvas
    class="w-full max-w-full touch-none rounded-xl border border-slate-600 bg-white"
  ></canvas>`,
  styles: [
    `
      canvas {
        display: block;
      }
    `,
  ],
})
export class TrackCanvasComponent implements OnChanges, AfterViewInit {
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @Input() state: GameState | null = null;

  private readonly game = inject(GameEngineService);
  private readonly room = inject(RoomService);
  private validMoves: { velocity: Vector2D; landing: Vector2D }[] = [];

  ngAfterViewInit(): void {
    const canvas = this.canvasRef.nativeElement;
    canvas.addEventListener('click', (e) => this.onTap(e));
    canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      this.onTap(e);
    });
  }

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

    canvas.width = track.width * CELL;
    canvas.height = track.height * CELL;

    this.drawPaper(ctx, track);
    this.drawGrass(ctx, track);
    this.drawFinishStripe(ctx, track);
    this.drawInkBoundaries(ctx, track);
    this.drawArrows(ctx, track);
    this.drawTrails(ctx, state);
    this.drawValidTargets(ctx, state, track);
    this.drawCars(ctx, state);
  }

  /** White sheet with light-gray grid lines. */
  private drawPaper(ctx: CanvasRenderingContext2D, track: TrackDefinition): void {
    ctx.fillStyle = PAPER_COLORS.paper;
    ctx.fillRect(0, 0, track.width * CELL, track.height * CELL);
    ctx.strokeStyle = PAPER_COLORS.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= track.width; x++) {
      ctx.moveTo(x * CELL + 0.5, 0);
      ctx.lineTo(x * CELL + 0.5, track.height * CELL);
    }
    for (let y = 0; y <= track.height; y++) {
      ctx.moveTo(0, y * CELL + 0.5);
      ctx.lineTo(track.width * CELL, y * CELL + 0.5);
    }
    ctx.stroke();
  }

  /** Green marker covering everything that is not track. */
  private drawGrass(ctx: CanvasRenderingContext2D, track: TrackDefinition): void {
    ctx.fillStyle = PAPER_COLORS.grass;
    for (let y = 0; y < track.height; y++) {
      for (let x = 0; x < track.width; x++) {
        if (track.grid[y][x] === 'grass') {
          ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
        }
      }
    }
  }

  private drawFinishStripe(ctx: CanvasRenderingContext2D, track: TrackDefinition): void {
    ctx.fillStyle = PAPER_COLORS.finish;
    for (let y = 0; y < track.height; y++) {
      for (let x = 0; x < track.width; x++) {
        if (track.grid[y][x] === 'finish') {
          ctx.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
        }
      }
    }
  }

  /** Thick hand-inked black boundary wherever track meets grass. */
  private drawInkBoundaries(ctx: CanvasRenderingContext2D, track: TrackDefinition): void {
    const isRoad = (x: number, y: number): boolean => {
      const t = track.grid[y]?.[x];
      return t === 'track' || t === 'finish';
    };
    // Deterministic jitter so the line looks sketched but is stable per frame.
    const jitter = (x: number, y: number): number =>
      ((Math.sin(x * 127.1 + y * 311.7) * 43758.5453) % 1) * 1.6 - 0.8;

    ctx.strokeStyle = PAPER_COLORS.ink;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let y = 0; y < track.height; y++) {
      for (let x = 0; x < track.width; x++) {
        if (!isRoad(x, y)) continue;
        const px = x * CELL;
        const py = y * CELL;
        if (!isRoad(x, y - 1)) {
          ctx.moveTo(px - 1, py + jitter(x, y));
          ctx.lineTo(px + CELL + 1, py + jitter(x + 1, y));
        }
        if (!isRoad(x, y + 1)) {
          ctx.moveTo(px - 1, py + CELL + jitter(x, y + 1));
          ctx.lineTo(px + CELL + 1, py + CELL + jitter(x + 1, y + 1));
        }
        if (!isRoad(x - 1, y)) {
          ctx.moveTo(px + jitter(x, y), py - 1);
          ctx.lineTo(px + jitter(x, y + 1), py + CELL + 1);
        }
        if (!isRoad(x + 1, y)) {
          ctx.moveTo(px + CELL + jitter(x + 1, y), py - 1);
          ctx.lineTo(px + CELL + jitter(x + 1, y + 1), py + CELL + 1);
        }
      }
    }
    ctx.stroke();
  }

  /** Small black race-direction arrows near the stripe. */
  private drawArrows(ctx: CanvasRenderingContext2D, track: TrackDefinition): void {
    ctx.strokeStyle = PAPER_COLORS.ink;
    ctx.fillStyle = PAPER_COLORS.ink;
    ctx.lineWidth = 2;
    for (const arrow of track.arrows) {
      const cx = arrow.at.x * CELL;
      const cy = arrow.at.y * CELL;
      const dx = arrow.dir.x;
      const dy = arrow.dir.y;
      const len = CELL * 1.6;
      const tipX = cx + (dx * len) / 2;
      const tipY = cy + (dy * len) / 2;
      ctx.beginPath();
      ctx.moveTo(cx - (dx * len) / 2, cy - (dy * len) / 2);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      // arrow head
      const nx = -dy;
      const ny = dx;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - dx * 5 + nx * 3.5, tipY - dy * 5 + ny * 3.5);
      ctx.lineTo(tipX - dx * 5 - nx * 3.5, tipY - dy * 5 - ny * 3.5);
      ctx.closePath();
      ctx.fill();
    }
  }

  private center(p: Vector2D): [number, number] {
    return [p.x * CELL + CELL / 2, p.y * CELL + CELL / 2];
  }

  /** Each car's pen trail: a polyline with a dot at every past position. */
  private drawTrails(ctx: CanvasRenderingContext2D, state: GameState): void {
    for (const player of state.players) {
      const trail = player.trail ?? [];
      if (trail.length === 0) continue;
      ctx.strokeStyle = player.color;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      const [sx, sy] = this.center(trail[0]);
      ctx.moveTo(sx, sy);
      for (let i = 1; i < trail.length; i++) {
        const [x, y] = this.center(trail[i]);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = player.color;
      for (const p of trail) {
        const [x, y] = this.center(p);
        ctx.beginPath();
        ctx.arc(x, y, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /** Squares the active player can tap, in their pen color. */
  private drawValidTargets(
    ctx: CanvasRenderingContext2D,
    state: GameState,
    track: TrackDefinition
  ): void {
    this.validMoves = [];
    const myId = this.room.room?.connectionId;
    const active = this.game.currentPlayer();
    if (state.phase !== 'GAME_ROUND' || !active || active.connectionId !== myId) return;

    this.validMoves = getValidMoves(active, track);
    const color = active.color;
    for (const m of this.validMoves) {
      const px = m.landing.x * CELL;
      const py = m.landing.y * CELL;
      ctx.fillStyle = color + '33';
      ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 1.5, py + 1.5, CELL - 3, CELL - 3);
    }

    // Dashed hint from the car to the coasting spot (unchanged velocity).
    const coast = this.validMoves.find(
      (m) => m.velocity.x === active.velocity.x && m.velocity.y === active.velocity.y
    );
    if (coast && (active.velocity.x !== 0 || active.velocity.y !== 0)) {
      const [ax, ay] = this.center(active.position);
      const [bx, by] = this.center(coast.landing);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = color + '99';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawCars(ctx: CanvasRenderingContext2D, state: GameState): void {
    const active = this.game.currentPlayer();
    for (const player of state.players) {
      if (player.finishOrder !== undefined && state.phase !== 'GAME_OVER') continue;
      const [cx, cy] = this.center(player.position);
      const isActive = player.connectionId === active?.connectionId;

      if (isActive) {
        ctx.beginPath();
        ctx.arc(cx, cy, 8.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = player.color;
      ctx.fill();
      ctx.strokeStyle = PAPER_COLORS.ink;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  /** Tap → nearest valid landing square within ~1 cell (generous on mobile). */
  private onTap(event: MouseEvent | TouchEvent): void {
    const state = this.state;
    if (!state || state.phase !== 'GAME_ROUND' || !this.game.isMyTurn()) return;
    if (this.validMoves.length === 0) return;

    const canvas = this.canvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();
    let clientX: number;
    let clientY: number;
    if ('changedTouches' in event) {
      const t = event.changedTouches[0];
      clientX = t.clientX;
      clientY = t.clientY;
    } else {
      clientX = event.clientX;
      clientY = event.clientY;
    }

    const gx = ((clientX - rect.left) * (canvas.width / rect.width)) / CELL - 0.5;
    const gy = ((clientY - rect.top) * (canvas.height / rect.height)) / CELL - 0.5;

    let best: { velocity: Vector2D; landing: Vector2D } | null = null;
    let bestDist = Infinity;
    for (const m of this.validMoves) {
      const d = Math.hypot(m.landing.x - gx, m.landing.y - gy);
      if (d < bestDist) {
        bestDist = d;
        best = m;
      }
    }
    if (best && bestDist <= 1.15) {
      this.game.submitMove(best.velocity);
    }
  }
}
