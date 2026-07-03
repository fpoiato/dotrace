import { Routes } from '@angular/router';
import { LandingComponent } from './features/landing/landing.component';
import { LobbyComponent } from './features/lobby/lobby.component';
import { GameRoomComponent } from './features/game/game-room.component';

export const routes: Routes = [
  { path: '', component: LandingComponent },
  { path: 'lobby', component: LobbyComponent },
  { path: 'game', component: GameRoomComponent },
  { path: '**', redirectTo: '' },
];
