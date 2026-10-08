import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { PAPER_COLORS } from '../core/models/tracks';
import { TrackDefinition, resolvedDrsZones } from '../core/models/ws-types';

@Component({
  selector: 'app-track-picker',
  standalone: true,
  imports: [TranslateModule],
  templateUrl: './track-picker.component.html',
})
export class TrackPickerComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) tracks!: TrackDefinition[];
  @Input() selectedTrackId = '';
  @Output() readonly trackSelected = new EventEmitter<string>();

  @ViewChild('preview') previewRef?: ElementRef<HTMLCanvasElement>;

  index = 0;
  private touchStartX = 0;
  private resizeObserver?: ResizeObserver;

  get current(): TrackDefinition | undefined {
    return this.tracks[this.index];
  }

  get chosen(): boolean {
    return !!this.current && this.current.id === this.selectedTrackId;
  }

  ngAfterViewInit(): void {
    this.syncIndex(false);
    const canvas = this.previewRef?.nativeElement;
    if (canvas && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.paint());
      this.resizeObserver.observe(canvas);
    }
    requestAnimationFrame(() => this.paint());
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['tracks'] || changes['selectedTrackId']) {
      this.syncIndex(false);
      this.paint();
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  prev(): void {
    if (!this.tracks.length) return;
    this.index = (this.index - 1 + this.tracks.length) % this.tracks.length;
    this.commit();
  }

  next(): void {
    if (!this.tracks.length) return;
    this.index = (this.index + 1) % this.tracks.length;
    this.commit();
  }

  go(index: number): void {
    if (index < 0 || index >= this.tracks.length) return;
    this.index = index;
    this.commit();
  }

  chooseCurrent(): void {
    this.commit();
  }

  onTouchStart(event: TouchEvent): void {
    this.touchStartX = event.changedTouches[0]?.clientX ?? 0;
  }

  onTouchEnd(event: TouchEvent): void {
    const dx = (event.changedTouches[0]?.clientX ?? 0) - this.touchStartX;
    if (dx > 40) this.prev();
    else if (dx < -40) this.next();
  }

  private syncIndex(emit: boolean): void {
    if (!this.tracks?.length) return;
    const found = this.tracks.findIndex((t) => t.id === this.selectedTrackId);
    this.index = found >= 0 ? found : Math.min(this.index, this.tracks.length - 1);
    if (emit) this.commit();
  }

  private commit(): void {
    const track = this.current;
    this.paint();
    if (track && track.id !== this.selectedTrackId) {
      this.trackSelected.emit(track.id);
    }
  }

  private paint(): void {
    const canvas = this.previewRef?.nativeElement;
    const track = this.current;
    if (!canvas || !track) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 320;
    const h = canvas.clientHeight || 168;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, w, h);

    const pad = 12;
    const scale = Math.min((w - pad * 2) / track.width, (h - pad * 2) / track.height);
    const ox = (w - track.width * scale) / 2;
    const oy = (h - track.height * scale) / 2;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);
    ctx.fillStyle = PAPER_COLORS.paper;
    ctx.fillRect(0, 0, track.width, track.height);
    ctx.fillStyle = PAPER_COLORS.grass;
    for (let y = 0; y < track.height; y++) {
      const row = track.grid[y];
      for (let x = 0; x < track.width; x++) {
        const tile = row[x];
        if (tile === 'grass' || tile === 'rumble') {
          ctx.fillRect(x, y, 1, 1);
        } else if (tile === 'finish') {
          ctx.fillStyle = PAPER_COLORS.finishDark;
          ctx.fillRect(x, y, 1, 1);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(x, y, 0.5, 0.5);
          ctx.fillRect(x + 0.5, y + 0.5, 0.5, 0.5);
          ctx.fillStyle = PAPER_COLORS.grass;
        }
      }
    }
    ctx.fillStyle = 'rgba(37, 99, 235, 0.55)';
    for (const zone of resolvedDrsZones(track)) {
      for (const cell of zone.cells) ctx.fillRect(cell.x, cell.y, 1, 1);
    }
    ctx.restore();
  }
}
