import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
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

/** World pixels per grid cell (all drawing happens in world coordinates). */
const CELL = 16;
const MIN_CELL_PX = 8;
const MAX_CELL_PX = 46;

/**
 * "Pen and paper" renderer with a camera. On phones the camera follows the
 * action zoomed-in (framing your car and every square you can tap); the
 * overlay buttons zoom in/out or toggle the whole-track view.
 */
@Component({
  selector: 'app-track-canvas',
  standalone: true,
  template: `
    <div class="relative">
      <canvas
        #canvas
        class="h-[48vh] w-full touch-none rounded-xl border border-slate-600 md:h-[62vh]"
      ></canvas>
      <div class="absolute bottom-2 right-2 flex flex-col gap-1">
        <button
          type="button"
          aria-label="Zoom in"
          (click)="zoomIn()"
          class="h-10 w-10 rounded-lg bg-slate-900/80 text-lg font-bold text-white active:bg-slate-700"
        >
          +
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          (click)="zoomOut()"
          class="h-10 w-10 rounded-lg bg-slate-900/80 text-lg font-bold text-white active:bg-slate-700"
        >
          −
        </button>
        <button
          type="button"
          aria-label="Toggle full track"
          (click)="toggleFit()"
          class="h-10 w-10 rounded-lg text-sm font-bold text-white active:bg-slate-700"
          [class]="fitMode ? 'bg-orange-500' : 'bg-slate-900/80'"
        >
          ⛶
        </button>
      </div>
    </div>
  `,
  styles: [
    `
      canvas {
        display: block;
        background: #0b1220;
      }
    `,
  ],
})
export class TrackCanvasComponent implements OnChanges, AfterViewInit, OnDestroy {
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @Input() state: GameState | null = null;

  private readonly game = inject(GameEngineService);
  private readonly room = inject(RoomService);
  private validMoves: { velocity: Vector2D; landing: Vector2D }[] = [];

  fitMode = false;
  private zoomFactor = 1;
  private fitModeInitialized = false;
  /** Current view transform: world px → device px. */
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private readonly onResize = () => requestAnimationFrame(() => this.draw());

  ngAfterViewInit(): void {
    const canvas = this.canvasRef.nativeElement;
    canvas.addEventListener('click', (e) => this.onTap(e));
    canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      this.onTap(e);
    });
    window.addEventListener('resize', this.onResize);
    requestAnimationFrame(() => this.draw());
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onResize);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['state']) {
      requestAnimationFrame(() => this.draw());
    }
  }

  zoomIn(): void {
    this.zoomFactor = Math.min(3, this.zoomFactor * 1.3);
    this.fitMode = false;
    this.draw();
  }

  zoomOut(): void {
    this.zoomFactor = Math.max(0.4, this.zoomFactor / 1.3);
    this.draw();
  }

  toggleFit(): void {
    this.fitMode = !this.fitMode;
    this.zoomFactor = 1;
    this.draw();
  }

  private myPlayer(state: GameState): Player | undefined {
    const id = this.room.room?.connectionId;
    return state.players.find((p) => p.connectionId === id);
  }

  /** The player whose turn it is, derived from the rendered state itself. */
  private activePlayer(state: GameState): Player | undefined {
    if (state.phase !== 'GAME_ROUND') return undefined;
    const id = state.turnOrder[state.currentTurnIndex];
    return state.players.find((p) => p.connectionId === id);
  }

  /**
   * Frame the interesting region: my car plus every reachable landing when it
   * is my turn, otherwise the car in focus — clamped to sane zoom levels.
   */
  private computeCamera(state: GameState, track: TrackDefinition): void {
    const canvas = this.canvasRef.nativeElement;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth * dpr;
    const ch = canvas.clientHeight * dpr;
    canvas.width = cw;
    canvas.height = ch;

    const worldW = track.width * CELL;
    const worldH = track.height * CELL;

    if (!this.fitModeInitialized) {
      // Big screens start with the whole sheet; phones start zoomed on the action.
      this.fitMode = canvas.clientWidth >= 640;
      this.fitModeInitialized = true;
    }

    if (this.fitMode || state.phase !== 'GAME_ROUND') {
      const s = Math.min(cw / worldW, ch / worldH) * this.zoomFactor;
      this.scale = s;
      this.offsetX = (cw - worldW * s) / 2;
      this.offsetY = (ch - worldH * s) / 2;
      return;
    }

    const focus = this.myPlayer(state) ?? this.activePlayer(state);
    if (!focus) {
      const s = Math.min(cw / worldW, ch / worldH);
      this.scale = s;
      this.offsetX = (cw - worldW * s) / 2;
      this.offsetY = (ch - worldH * s) / 2;
      return;
    }

    const pts: Vector2D[] = [focus.position];
    const myId = this.room.room?.connectionId;
    if (focus.connectionId === myId && focus.finishOrder === undefined) {
      for (const m of getValidMoves(focus, track)) {
        pts.push(m.landing);
      }
    }
    let minX = Math.min(...pts.map((p) => p.x));
    let maxX = Math.max(...pts.map((p) => p.x));
    let minY = Math.min(...pts.map((p) => p.y));
    let maxY = Math.max(...pts.map((p) => p.y));
    // generous margin so players see the road around the action
    const margin = 5;
    minX -= margin;
    maxX += margin;
    minY -= margin;
    maxY += margin;

    const boxW = (maxX - minX + 1) * CELL;
    const boxH = (maxY - minY + 1) * CELL;
    let cellPx = Math.min(cw / (boxW / CELL), ch / (boxH / CELL)) * this.zoomFactor;
    cellPx = Math.max(MIN_CELL_PX * (window.devicePixelRatio || 1), Math.min(MAX_CELL_PX * (window.devicePixelRatio || 1), cellPx));
    const s = cellPx / CELL;

    let cxWorld = ((minX + maxX + 1) / 2) * CELL;
    let cyWorld = ((minY + maxY + 1) / 2) * CELL;
    // keep the camera inside the sheet when possible
    const viewW = cw / s;
    const viewH = ch / s;
    if (viewW < worldW) {
      cxWorld = Math.max(viewW / 2, Math.min(worldW - viewW / 2, cxWorld));
    } else {
      cxWorld = worldW / 2;
    }
    if (viewH < worldH) {
      cyWorld = Math.max(viewH / 2, Math.min(worldH - viewH / 2, cyWorld));
    } else {
      cyWorld = worldH / 2;
    }

    this.scale = s;
    this.offsetX = cw / 2 - cxWorld * s;
    this.offsetY = ch / 2 - cyWorld * s;
  }

  private draw(): void {
    const canvas = this.canvasRef.nativeElement;
    const ctx = canvas.getContext('2d');
    const state = this.state;
    if (!ctx || !state?.trackId) return;

    const track = getTrackById(state.trackId);
    if (!track) return;

    this.computeCamera(state, track);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);

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
    const active = this.activePlayer(state);
    if (!active || active.connectionId !== myId || active.finishOrder !== undefined) return;

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
    const active = this.activePlayer(state);
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

    // client → device px → world px → cell coordinates
    const deviceX = (clientX - rect.left) * (canvas.width / rect.width);
    const deviceY = (clientY - rect.top) * (canvas.height / rect.height);
    const gx = (deviceX - this.offsetX) / this.scale / CELL - 0.5;
    const gy = (deviceY - this.offsetY) / this.scale / CELL - 0.5;

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
