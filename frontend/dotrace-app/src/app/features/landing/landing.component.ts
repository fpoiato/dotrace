import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { LanguageToggleComponent } from '../../shared/language-toggle.component';
import { RoomService } from '../../core/services/room.service';
import { SessionStorageService } from '../../core/services/session-storage.service';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [FormsModule, TranslateModule, LanguageToggleComponent],
  templateUrl: './landing.component.html',
})
export class LandingComponent implements OnInit {
  private readonly room = inject(RoomService);
  private readonly session = inject(SessionStorageService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  nickname = '';
  roomCode = '';
  showJoin = false;
  loading = false;
  error = '';

  ngOnInit(): void {
    const deepLink = this.route.snapshot.queryParamMap.get('room');
    if (deepLink) {
      this.showJoin = true;
      this.roomCode = deepLink.toUpperCase();
    }

    const saved = this.session.load();
    if (saved?.nickname) {
      this.nickname = saved.nickname;
    }

    if (saved?.roomCode && saved.connectionId) {
      this.loading = true;
      this.room
        .rejoinSession()
        .then(() => {
          const screen = saved.screen ?? 'lobby';
          void this.router.navigate([screen === 'game' ? '/game' : '/lobby']);
        })
        .catch(() => {
          this.loading = false;
          this.session.clear();
        });
    }
  }

  openJoin(): void {
    this.showJoin = true;
  }

  back(): void {
    this.showJoin = false;
    this.error = '';
  }

  async createGame(): Promise<void> {
    if (!this.nickname.trim()) return;
    this.loading = true;
    this.error = '';
    try {
      this.session.save({ nickname: this.nickname.trim() });
      await this.room.createRoom(this.nickname.trim());
      await this.router.navigate(['/lobby']);
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Error';
    } finally {
      this.loading = false;
    }
  }

  async joinGame(): Promise<void> {
    if (!this.nickname.trim() || this.roomCode.trim().length !== 5) return;
    this.loading = true;
    this.error = '';
    try {
      this.session.save({ nickname: this.nickname.trim() });
      await this.room.joinRoom(this.nickname.trim(), this.roomCode.trim());
      await this.router.navigate(['/lobby']);
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Error';
    } finally {
      this.loading = false;
    }
  }
}
