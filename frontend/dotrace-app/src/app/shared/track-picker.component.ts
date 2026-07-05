import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { TrackDefinition } from '../core/models/ws-types';

@Component({
  selector: 'app-track-picker',
  standalone: true,
  imports: [TranslateModule],
  templateUrl: './track-picker.component.html',
})
export class TrackPickerComponent implements OnInit, OnDestroy {
  @Input({ required: true }) tracks!: TrackDefinition[];
  @Input() selectedTrackId = '';
  @Output() readonly trackSelected = new EventEmitter<string>();

  open = false;

  readonly closeLabelKey = 'common.close';

  get buttonLabelKey(): string {
    if (this.selectedTrackId) {
      return this.tracks.find((t) => t.id === this.selectedTrackId)?.nameKey ?? 'lobby.selectTrackPlaceholder';
    }
    return 'lobby.selectTrackPlaceholder';
  }

  ngOnInit(): void {
    if (this.open) {
      document.body.classList.add('scroll-locked');
    }
  }

  ngOnDestroy(): void {
    document.body.classList.remove('scroll-locked');
  }

  openPicker(): void {
    this.open = true;
    document.body.classList.add('scroll-locked');
  }

  closePicker(): void {
    this.open = false;
    document.body.classList.remove('scroll-locked');
  }

  trackLabelKey(track: TrackDefinition): string {
    return track.nameKey;
  }

  pick(trackId: string): void {
    this.trackSelected.emit(trackId);
    this.closePicker();
  }
}
