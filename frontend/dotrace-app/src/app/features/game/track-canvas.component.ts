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
import { getTrackById, TILE_COLORS } from '../../core/models/tracks';
import {
  GameState,
  Player,
  Vector2D,
  getValidMoves,
  posKey,
} from '../../core/models/ws-types';
import { GameEngineService } from '../../core/services/game-engine.service';
import { RoomService } from '../../core/services/room.service';

@Component({
  selector: 'app-track-canvas',
  standalone: true,
  template: `<canvas #canvas class="w-full max-w-full touch-none rounded-xl border border-slate-600"></canvas>`,
  styles: [
    `
      canvas {
        display: block;
        max-height: min(70vh, 520px);
        image-rendering: pixelated;
      }
    `,
  ],
})
export class TrackCanvasComponent implements OnChanges, AfterViewInit {
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @Input() state: GameState | null = null;

  private readonly game = inject(GameEngineService);
  private readonly room = inject(RoomService);
  private cellSize = 14;
  private validLandings = new Map<string, Vector2D>();

  ngAfterViewInit(): void {
    const canvas = this.canvasRef.nativeElement;
    canvas.addEventListener('click', (e) => this.onCanvasClick(e));
    canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      this.onCanvasClick(e);
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

    this.cellSize = Math.max(8, Math.min(16, Math.floor(320 / Math.max(track.width, track.height))));
    canvas.width = track.width * this.cellSize;
    canvas.height = track.height * this.cellSize;

    for (let y = 0; y < track.height; y++) {
      for (let x = 0; x < track.width; x++) {
        const tile = track.grid[y][x];
        ctx.fillStyle = TILE_COLORS[tile];
        ctx.fillRect(x * this.cellSize, y * this.cellSize, this.cellSize, this.cellSize);
      }
    }

    this.validLandings.clear();
    const myId = this.room.room?.connectionId;
    const active = this.game.currentPlayer();
    const showValid = state.phase === 'GAME_ROUND' && active?.connectionId === myId;

    if (showValid && active) {
      const moves = getValidMoves(active, track);
      ctx.fillStyle = 'rgba(34, 197, 94, 0.45)';
      for (const m of moves) {
        this.validLandings.set(posKey(m.landing), m.velocity);
        ctx.fillRect(
          m.landing.x * this.cellSize,
          m.landing.y * this.cellSize,
          this.cellSize,
          this.cellSize
        );
      }
    }

    for (const player of state.players) {
      if (player.finishOrder !== undefined && state.phase !== 'GAME_OVER') continue;
      this.drawDot(ctx, player, player.connectionId === active?.connectionId);
    }
  }

  private drawDot(ctx: CanvasRenderingContext2D, player: Player, isActive: boolean): void {
    const cx = player.position.x * this.cellSize + this.cellSize / 2;
    const cy = player.position.y * this.cellSize + this.cellSize / 2;
    const r = this.cellSize * 0.38;

    if (isActive) {
      ctx.beginPath();
      ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = player.color;
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (player.velocity.x !== 0 || player.velocity.y !== 0) {
      ctx.strokeStyle = player.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + player.velocity.x * this.cellSize * 0.8, cy + player.velocity.y * this.cellSize * 0.8);
      ctx.stroke();
    }
  }

  private onCanvasClick(event: MouseEvent | TouchEvent): void {
    const state = this.state;
    if (!state || state.phase !== 'GAME_ROUND' || !this.game.isMyTurn()) return;

    const canvas = this.canvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    // 'changedTouches' feature check — `instanceof TouchEvent` throws on
    // browsers that don't define the TouchEvent global (e.g. desktop Firefox).
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

    const x = Math.floor(((clientX - rect.left) * scaleX) / this.cellSize);
    const y = Math.floor(((clientY - rect.top) * scaleY) / this.cellSize);
    const key = posKey({ x, y });
    const vector = this.validLandings.get(key);
    if (vector) {
      this.game.submitMove(vector);
    }
  }
}
