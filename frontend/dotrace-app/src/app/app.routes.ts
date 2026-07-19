import { Routes } from '@angular/router';
import { LandingComponent } from './features/landing/landing.component';
import { LobbyComponent } from './features/lobby/lobby.component';
import { GameRoomComponent } from './features/game/game-room.component';
import { SharedReplayComponent } from './features/game/shared-replay.component';

export const routes: Routes = [
  { path: '', component: LandingComponent },
  { path: 'lobby', component: LobbyComponent },
  { path: 'game', component: GameRoomComponent },
  { path: 'replay', component: SharedReplayComponent },
  { path: '**', redirectTo: '' },
];
