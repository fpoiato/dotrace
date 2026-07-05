/**
 * Game state processing (inbound).
 *
 * Turns loose WsEnvelope payloads into strongly typed runtime state:
 *  - room context (roomCode / connectionId / approval status)
 *  - the latest host-authoritative GameState from RELAY messages
 *
 * Emits high-level events ('approved', 'my-turn', 'game-over') so the entry
 * point never touches raw payloads.
 */
import { EventEmitter } from 'node:events';
import {
  GameState,
  Player,
  RelayPayload,
  WsEnvelope,
  canPlayerMove,
} from '../../shared/ws-types';
import { log } from './log';

export interface RoomContext {
  roomCode: string;
  connectionId: string;
  nickname: string;
  approved: boolean;
}

export class StateStore extends EventEmitter {
  private context: RoomContext | null = null;
  private state: GameState | null = null;
  /** Fingerprint of the last state we already acted on — prevents double moves. */
  private lastActedTurnKey = '';

  get room(): RoomContext | null {
    return this.context;
  }

  get gameState(): GameState | null {
    return this.state;
  }

  /** The bot's own car (position + velocity vectors) in the latest state. */
  get me(): Player | null {
    if (!this.state || !this.context) return null;
    return this.state.players.find((p) => p.connectionId === this.context!.connectionId) ?? null;
  }

  handleEnvelope(envelope: WsEnvelope): void {
    switch (envelope.action) {
      case 'JOIN_PENDING': {
        const p = envelope.payload as { roomCode: string; connectionId: string; nickname: string };
        // The server echoes our own connectionId on join — capture it, we are
        // now waiting for the host to approve us into the lobby.
        this.context = {
          roomCode: p.roomCode,
          connectionId: p.connectionId,
          nickname: p.nickname,
          approved: false,
        };
        log('STATE', `Joined room ${p.roomCode} as ${p.nickname} (${p.connectionId}) — awaiting host approval`);
        break;
      }

      case 'PLAYER_APPROVED': {
        const p = envelope.payload as { connectionId: string };
        if (this.context && p.connectionId === this.context.connectionId) {
          this.context.approved = true;
          log('STATE', 'Host approved the bot — in the lobby');
          this.emit('approved');
        }
        break;
      }

      case 'ROOM_REJOINED': {
        // Reconnect path: the server hands us a fresh connectionId; the host
        // remaps our car to it via PLAYER_REJOINED, so game state stays intact.
        const p = envelope.payload as { roomCode: string; connectionId: string; nickname: string };
        this.context = {
          roomCode: p.roomCode,
          connectionId: p.connectionId,
          nickname: p.nickname,
          approved: true,
        };
        log('STATE', `Rejoined room ${p.roomCode} with new connectionId ${p.connectionId}`);
        break;
      }

      case 'JOIN_REJECTED':
        log('ERROR', 'Host rejected the join request');
        this.emit('rejected');
        break;

      case 'ERROR': {
        const p = envelope.payload as { message?: string };
        log('ERROR', `Server error: ${p.message ?? 'unknown'}`);
        this.emit('server-error', p.message);
        break;
      }

      case 'RELAY':
        this.applyRelay(envelope.payload as RelayPayload);
        break;

      default:
        break;
    }
  }

  /** Parse a host RELAY into typed GameState and decide whether to act. */
  private applyRelay(relay: RelayPayload): void {
    const state = relay.state;
    if (!state?.phase) return;
    this.state = state;
    log('STATE', `RELAY ${relay.type} — phase=${state.phase} round=${state.round}`);

    if (state.phase === 'GAME_OVER') {
      this.emit('game-over', state);
      return;
    }

    const id = this.context?.connectionId;
    if (!id || !canPlayerMove(state, id)) return;

    // One move per distinct turn snapshot: keyed on round + turn pointer +
    // our kinematic state so TIMED mode (always "our turn") can't spin.
    const meNow = this.me;
    const turnKey = [
      state.round,
      state.currentTurnIndex,
      meNow ? `${meNow.position.x},${meNow.position.y}|${meNow.velocity.x},${meNow.velocity.y}` : '',
    ].join(':');
    if (turnKey === this.lastActedTurnKey) return;
    this.lastActedTurnKey = turnKey;

    this.emit('my-turn', state);
  }
}
