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
/** Finger/mouse travel (in CSS px) below which a gesture still counts as a tap. */
const TAP_SLOP = 10;

/**
 * "Pen and paper" renderer with a map-style camera: drag to pan, pinch or
 * use the overlay buttons to zoom, tap a highlighted square to move. The
 * camera auto-frames your car and options on your turn; panning hands
 * control to the user until their next turn (or the fit toggle).
 */
@Component({
  selector: 'app-track-canvas',
  standalone: true,
  template: `
    <div class="relative">
      <canvas
        #canvas
        class="h-[48vh] w-full cursor-grab touch-none rounded-xl border border-slate-600 active:cursor-grabbing md:h-[62vh]"
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
  /** True after the user pans/pinches: camera stops auto-following. */
  private manualCamera = false;
  private lastTrack: TrackDefinition | null = null;

  // gesture bookkeeping
  private pointerDown = false;
  private gestureMoved = false;
  private startX = 0;
  private startY = 0;
  private lastX = 0;
  private lastY = 0;
  private pinchDist = 0;
  private suppressClick = false;

  private readonly onResize = () => requestAnimationFrame(() => this.draw());
  private readonly onMouseMoveBound = (e: MouseEvent) => this.onMouseMove(e);
  private readonly onMouseUpBound = () => this.onMouseUp();

  ngAfterViewInit(): void {
    const canvas = this.canvasRef.nativeElement;
    canvas.addEventListener('click', (e) => this.onTap(e));
    canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', this.onMouseMoveBound);
    window.addEventListener('mouseup', this.onMouseUpBound);
    canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    canvas.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    canvas.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
    window.addEventListener('resize', this.onResize);
    requestAnimationFrame(() => this.draw());
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('mousemove', this.onMouseMoveBound);
    window.removeEventListener('mouseup', this.onMouseUpBound);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['state']) {
      // My turn → retake the camera so the reachable squares are framed.
      const state = this.state;
      if (state && this.activePlayer(state)?.connectionId === this.room.room?.connectionId) {
        this.manualCamera = false;
      }
      requestAnimationFrame(() => this.draw());
    }
  }

  // ---------------------------------------------------------------- camera

  zoomIn(): void {
    this.zoomBy(1.3);
  }

  zoomOut(): void {
    this.zoomBy(1 / 1.3);
  }

  private zoomBy(factor: number): void {
    const canvas = this.canvasRef.nativeElement;
    if (this.manualCamera) {
      this.scaleAround(canvas.width / 2, canvas.height / 2, factor);
    } else {
      this.zoomFactor = Math.min(3, Math.max(0.4, this.zoomFactor * factor));
      this.fitMode = factor > 1 ? false : this.fitMode;
    }
    this.draw();
  }

  toggleFit(): void {
    this.fitMode = !this.fitMode;
    this.zoomFactor = 1;
    this.manualCamera = false;
    this.draw();
  }

  private minScale(track: TrackDefinition): number {
    const canvas = this.canvasRef.nativeElement;
    return Math.min(canvas.width / (track.width * CELL), canvas.height / (track.height * CELL)) * 0.5;
  }

  private maxScale(): number {
    return (MAX_CELL_PX * (window.devicePixelRatio || 1)) / CELL;
  }

  /** Zoom keeping the given device-px point fixed on screen. */
  private scaleAround(px: number, py: number, factor: number): void {
    const track = this.lastTrack;
    if (!track) return;
    const next = Math.min(this.maxScale(), Math.max(this.minScale(track), this.scale * factor));
    const applied = next / this.scale;
    this.offsetX = px - applied * (px - this.offsetX);
    this.offsetY = py - applied * (py - this.offsetY);
    this.scale = next;
    this.clampOffsets(track);
  }

  /** Keep at least part of the sheet on screen while panning. */
  private clampOffsets(track: TrackDefinition): void {
    const canvas = this.canvasRef.nativeElement;
    const worldW = track.width * CELL * this.scale;
    const worldH = track.height * CELL * this.scale;
    const slackX = canvas.width * 0.6;
    const slackY = canvas.height * 0.6;
    this.offsetX = Math.min(slackX, Math.max(canvas.width - worldW - slackX, this.offsetX));
    this.offsetY = Math.min(slackY, Math.max(canvas.height - worldH - slackY, this.offsetY));
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
   * is my turn, otherwise the car in focus — unless the user took the camera.
   */
  private computeCamera(state: GameState, track: TrackDefinition): void {
    const canvas = this.canvasRef.nativeElement;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(canvas.clientWidth * dpr);
    const ch = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }

    const worldW = track.width * CELL;
    const worldH = track.height * CELL;

    if (!this.fitModeInitialized) {
      // Big screens start with the whole sheet; phones start zoomed on the action.
      this.fitMode = canvas.clientWidth >= 640;
      this.fitModeInitialized = true;
    }

    if (this.manualCamera && !this.fitMode) {
      this.clampOffsets(track);
      return;
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
    const margin = 5;
    minX -= margin;
    maxX += margin;
    minY -= margin;
    maxY += margin;

    const boxW = maxX - minX + 1;
    const boxH = maxY - minY + 1;
    let cellPx = Math.min(cw / boxW, ch / boxH) * this.zoomFactor;
    const dprScale = window.devicePixelRatio || 1;
    cellPx = Math.max(MIN_CELL_PX * dprScale, Math.min(MAX_CELL_PX * dprScale, cellPx));
    const s = cellPx / CELL;

    let cxWorld = ((minX + maxX + 1) / 2) * CELL;
    let cyWorld = ((minY + maxY + 1) / 2) * CELL;
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

  // -------------------------------------------------------------- gestures

  private cssToDevice(): number {
    const canvas = this.canvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();
    return rect.width > 0 ? canvas.width / rect.width : 1;
  }

  private onMouseDown(e: MouseEvent): void {
    this.pointerDown = true;
    this.gestureMoved = false;
    this.startX = this.lastX = e.clientX;
    this.startY = this.lastY = e.clientY;
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.pointerDown) return;
    if (!this.gestureMoved) {
      if (Math.hypot(e.clientX - this.startX, e.clientY - this.startY) < TAP_SLOP) return;
      this.gestureMoved = true;
      this.manualCamera = true;
      this.fitMode = false;
    }
    const k = this.cssToDevice();
    this.offsetX += (e.clientX - this.lastX) * k;
    this.offsetY += (e.clientY - this.lastY) * k;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.lastTrack) this.clampOffsets(this.lastTrack);
    this.draw();
  }

  private onMouseUp(): void {
    if (this.pointerDown && this.gestureMoved) {
      this.suppressClick = true;
    }
    this.pointerDown = false;
  }

  private onTouchStart(e: TouchEvent): void {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      this.pointerDown = true;
      this.gestureMoved = false;
      this.startX = this.lastX = t.clientX;
      this.startY = this.lastY = t.clientY;
    } else if (e.touches.length === 2) {
      e.preventDefault();
      this.pointerDown = true;
      this.gestureMoved = true;
      this.manualCamera = true;
      this.fitMode = false;
      this.pinchDist = this.touchDist(e);
      const [mx, my] = this.touchMid(e);
      this.lastX = mx;
      this.lastY = my;
    }
  }

  private onTouchMove(e: TouchEvent): void {
    e.preventDefault();
    if (e.touches.length === 1 && this.pointerDown) {
      const t = e.touches[0];
      if (!this.gestureMoved) {
        if (Math.hypot(t.clientX - this.startX, t.clientY - this.startY) < TAP_SLOP) return;
        this.gestureMoved = true;
        this.manualCamera = true;
        this.fitMode = false;
      }
      const k = this.cssToDevice();
      this.offsetX += (t.clientX - this.lastX) * k;
      this.offsetY += (t.clientY - this.lastY) * k;
      this.lastX = t.clientX;
      this.lastY = t.clientY;
      if (this.lastTrack) this.clampOffsets(this.lastTrack);
      this.draw();
    } else if (e.touches.length === 2) {
      const dist = this.touchDist(e);
      const [mx, my] = this.touchMid(e);
      const canvas = this.canvasRef.nativeElement;
      const rect = canvas.getBoundingClientRect();
      const k = this.cssToDevice();
      if (this.pinchDist > 0) {
        this.scaleAround((mx - rect.left) * k, (my - rect.top) * k, dist / this.pinchDist);
      }
      this.offsetX += (mx - this.lastX) * k;
      this.offsetY += (my - this.lastY) * k;
      this.pinchDist = dist;
      this.lastX = mx;
      this.lastY = my;
      if (this.lastTrack) this.clampOffsets(this.lastTrack);
      this.draw();
    }
  }

  private onTouchEnd(e: TouchEvent): void {
    e.preventDefault();
    if (e.touches.length === 1) {
      // pinch → single finger: re-anchor to avoid a jump
      const t = e.touches[0];
      this.lastX = t.clientX;
      this.lastY = t.clientY;
      this.pinchDist = 0;
      return;
    }
    if (e.touches.length > 0) return;
    const wasTap = this.pointerDown && !this.gestureMoved;
    this.pointerDown = false;
    this.pinchDist = 0;
    if (wasTap) {
      this.onTap(e);
    }
  }

  private touchDist(e: TouchEvent): number {
    const a = e.touches[0];
    const b = e.touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  private touchMid(e: TouchEvent): [number, number] {
    const a = e.touches[0];
    const b = e.touches[1];
    return [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2];
  }

  // -------------------------------------------------------------- painting

  private draw(): void {
    const canvas = this.canvasRef.nativeElement;
    const ctx = canvas.getContext('2d');
    const state = this.state;
    if (!ctx || !state?.trackId) return;

    const track = getTrackById(state.trackId);
    if (!track) return;
    this.lastTrack = track;

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
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
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
