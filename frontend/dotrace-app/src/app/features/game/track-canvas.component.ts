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
import { TranslateModule } from '@ngx-translate/core';
import { PAPER_COLORS, getTrackById } from '../../core/models/tracks';
import {
  GameState,
  MAX_GEAR,
  Player,
  TrackDefinition,
  Vector2D,
  canPlayerMove,
  gearOf,
  getValidMoves,
  isGrassShortcut,
  isKerbGrass,
  segmentTouchesKerb,
  isTimedMode,
  getTileAt,
  segmentCrossesRumble,
} from '../../core/models/ws-types';
import { GameEngineService } from '../../core/services/game-engine.service';
import { HapticService } from '../../core/services/haptic.service';
import { RoomService } from '../../core/services/room.service';

/** World pixels per grid cell (all drawing happens in world coordinates). */
const CELL = 16;
const MIN_CELL_PX = 8;
const MAX_CELL_PX = 46;
/** Finger/mouse travel (in CSS px) below which a gesture still counts as a tap. */
const TAP_SLOP = 10;

/** Precomputed arc paths for the 6-segment gear gauge (100×62 viewBox). */
function buildGaugeSegments(): string[] {
  const cx = 50;
  const cy = 54;
  const r = 38;
  const gap = 0.015;
  const point = (f: number): [number, number] => {
    const angle = Math.PI - f * Math.PI;
    return [cx + r * Math.cos(angle), cy - r * Math.sin(angle)];
  };
  const paths: string[] = [];
  for (let i = 0; i < MAX_GEAR; i++) {
    const [x0, y0] = point(i / MAX_GEAR + gap);
    const [x1, y1] = point((i + 1) / MAX_GEAR - gap);
    paths.push(`M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`);
  }
  return paths;
}

/**
 * "Pen and paper" renderer with a map-style camera: drag to pan, pinch or
 * use the overlay buttons to zoom, tap a highlighted square to move. The
 * camera auto-frames your car on first load; pan/zoom hands control to the
 * user until they tap the fit toggle or a new race starts.
 */
@Component({
  selector: 'app-track-canvas',
  standalone: true,
  imports: [TranslateModule],
  template: `
    <div class="relative" [class.h-full]="fill" [class.w-full]="fill">
      <canvas
        #canvas
        class="track-sheet w-full cursor-grab touch-none rounded-xl border border-slate-600 active:cursor-grabbing"
        [class.track-sheet-fill]="fill"
      ></canvas>
      @if (gaugePlayer; as me) {
        <div class="pointer-events-none absolute bottom-2 left-2 rounded-xl bg-slate-900/75 px-1 pb-1 pt-2">
          <svg viewBox="0 0 100 62" class="block h-14 w-24">
            @for (seg of gaugeSegments; track $index) {
              <path
                [attr.d]="seg"
                fill="none"
                stroke-width="9"
                stroke-linecap="round"
                [attr.stroke]="segmentColor(me, $index)"
              />
            }
            <text
              x="50"
              y="52"
              text-anchor="middle"
              font-size="26"
              font-weight="800"
              [attr.fill]="me.isOffTrack ? '#FBBF24' : '#ffffff'"
            >
              {{ gaugeGear(me) }}
            </text>
          </svg>
        </div>
      }
      <div class="absolute bottom-2 right-2 flex flex-col gap-1">
        <button
          type="button"
          [attr.aria-label]="'game.map.zoomIn' | translate"
          (click)="zoomIn()"
          class="h-10 w-10 rounded-lg bg-slate-900/80 text-lg font-bold text-white active:bg-slate-700"
        >
          +
        </button>
        <button
          type="button"
          [attr.aria-label]="'game.map.zoomOut' | translate"
          (click)="zoomOut()"
          class="h-10 w-10 rounded-lg bg-slate-900/80 text-lg font-bold text-white active:bg-slate-700"
        >
          −
        </button>
        <button
          type="button"
          [attr.aria-label]="'game.map.toggleFit' | translate"
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
      .track-sheet {
        height: 48dvh;
      }
      .track-sheet-fill {
        height: 100%;
      }
      @media (min-width: 768px) {
        .track-sheet:not(.track-sheet-fill) {
          height: 62dvh;
        }
      }
    `,
  ],
})
export class TrackCanvasComponent implements OnChanges, AfterViewInit, OnDestroy {
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @Input() state: GameState | null = null;
  /** Stretch the sheet to the parent instead of a fixed viewport slice. */
  @Input() fill = false;

  private readonly game = inject(GameEngineService);
  private readonly haptic = inject(HapticService);
  private readonly room = inject(RoomService);
  private validMoves: { velocity: Vector2D; landing: Vector2D }[] = [];

  fitMode = false;
  readonly gaugeSegments = buildGaugeSegments();
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
  private resizeObserver: ResizeObserver | null = null;
  private lastCssW = 0;
  private lastCssH = 0;

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
    this.resizeObserver = new ResizeObserver(() => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === this.lastCssW && h === this.lastCssH) return;
      this.lastCssW = w;
      this.lastCssH = h;
      this.draw();
    });
    this.resizeObserver.observe(canvas);
    requestAnimationFrame(() => this.draw());
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('mousemove', this.onMouseMoveBound);
    window.removeEventListener('mouseup', this.onMouseUpBound);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['state']) {
      const prev = changes['state'].previousValue as GameState | null | undefined;
      const curr = changes['state'].currentValue as GameState | null | undefined;
      // New track or green flag: re-enable auto-framing once.
      if (
        prev?.trackId !== curr?.trackId ||
        (prev?.phase !== 'GAME_ROUND' && curr?.phase === 'GAME_ROUND')
      ) {
        this.manualCamera = false;
        this.fitModeInitialized = false;
        this.zoomFactor = 1;
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
    const state = this.state;
    const track = state?.trackId ? getTrackById(state.trackId) : this.lastTrack;
    if (!track) return;

    if (this.fitMode) {
      this.zoomFactor = Math.min(3, Math.max(0.4, this.zoomFactor * factor));
    } else if (!this.manualCamera) {
      // Commit the current auto-frame, then keep scale under user control.
      if (state) this.computeCamera(state, track);
      this.manualCamera = true;
      this.fitMode = false;
      this.scaleAround(canvas.width / 2, canvas.height / 2, factor);
    } else {
      this.scaleAround(canvas.width / 2, canvas.height / 2, factor);
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

  /** My car, for the gear gauge overlay (null while spectating). */
  get gaugePlayer(): Player | null {
    const state = this.state;
    if (!state || (state.phase !== 'GAME_ROUND' && state.phase !== 'GAME_OVER')) return null;
    return this.myPlayer(state) ?? null;
  }

  gaugeGear(player: Player): number {
    return gearOf(player.velocity);
  }

  segmentColor(player: Player, index: number): string {
    const gear = this.gaugeGear(player);
    if (index >= gear) return '#334155';
    return player.isOffTrack ? '#FBBF24' : player.color;
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
      for (const m of getValidMoves(focus, track, state.players, state.round)) {
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
    this.drawTrackBorders(ctx, track);
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

  /** Green marker covering everything that is not track (rumble stays grass-colored). */
  private drawGrass(ctx: CanvasRenderingContext2D, track: TrackDefinition): void {
    ctx.fillStyle = PAPER_COLORS.grass;
    for (let y = 0; y < track.height; y++) {
      for (let x = 0; x < track.width; x++) {
        const tile = track.grid[y][x];
        if (tile === 'grass' || tile === 'rumble') {
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

  /** Off-track neighbor (grass, rumble, or outside the grid). */
  private isOffTrack(track: TrackDefinition, x: number, y: number): boolean {
    const t = track.grid[y]?.[x];
    return t === 'grass' || t === 'rumble' || t === null || t === undefined;
  }

  /**
   * Full track outline as a continuous red/white zebra border — every edge
   * where the road meets grass/rumble (no black ink line).
   */
  private drawTrackBorders(ctx: CanvasRenderingContext2D, track: TrackDefinition): void {
    const jitter = (x: number, y: number): number =>
      ((Math.sin(x * 127.1 + y * 311.7) * 43758.5453) % 1) * 1.6 - 0.8;
    const segLen = 4;

    ctx.lineWidth = 3.5;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';

    for (let y = 0; y < track.height; y++) {
      for (let x = 0; x < track.width; x++) {
        const tile = track.grid[y][x];
        if (tile !== 'track' && tile !== 'finish') continue;
        const px = x * CELL;
        const py = y * CELL;

        if (this.isOffTrack(track, x, y - 1)) {
          this.drawZebraEdge(ctx, px, py + jitter(x, y), px + CELL, py + jitter(x + 1, y), segLen);
        }
        if (this.isOffTrack(track, x, y + 1)) {
          this.drawZebraEdge(
            ctx,
            px,
            py + CELL + jitter(x, y + 1),
            px + CELL,
            py + CELL + jitter(x + 1, y + 1),
            segLen
          );
        }
        if (this.isOffTrack(track, x - 1, y)) {
          this.drawZebraEdge(ctx, px + jitter(x, y), py, px + jitter(x, y + 1), py + CELL, segLen);
        }
        if (this.isOffTrack(track, x + 1, y)) {
          this.drawZebraEdge(
            ctx,
            px + CELL + jitter(x + 1, y),
            py,
            px + CELL + jitter(x + 1, y + 1),
            py + CELL,
            segLen
          );
        }
      }
    }
  }

  /** Alternating red/white dashes along one border edge. */
  private drawZebraEdge(
    ctx: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    segLen: number
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) return;
    const segments = Math.max(1, Math.ceil(len / segLen));
    for (let i = 0; i < segments; i++) {
      ctx.strokeStyle = i % 2 === 0 ? PAPER_COLORS.rumbleRed : PAPER_COLORS.rumbleWhite;
      const t0 = i / segments;
      const t1 = (i + 1) / segments;
      ctx.beginPath();
      ctx.moveTo(x0 + dx * t0, y0 + dy * t0);
      ctx.lineTo(x0 + dx * t1, y0 + dy * t1);
      ctx.stroke();
    }
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
    if (!myId || !canPlayerMove(state, myId)) return;

    const active = isTimedMode(state) ? this.myPlayer(state) : this.activePlayer(state);
    if (!active || active.connectionId !== myId || active.finishOrder !== undefined) return;

    this.validMoves = getValidMoves(active, track, state.players, state.round);
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
      const state = this.state;
      const track = state?.trackId ? getTrackById(state.trackId) : undefined;
      const me = state ? this.myPlayer(state) : null;
      if (me && track) {
        const landing = best.landing;
        if (isGrassShortcut(track, me.position, landing)) {
          this.haptic.grassHit();
        } else if (
          getTileAt(track, landing.x, landing.y) === 'rumble' ||
          isKerbGrass(track, landing.x, landing.y) ||
          segmentCrossesRumble(track, me.position, landing) ||
          segmentTouchesKerb(track, me.position, landing)
        ) {
          this.haptic.rumbleStrip();
        }
      }
      this.game.submitMove(best.velocity);
    }
  }
}
