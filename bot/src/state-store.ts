/**
 * Game-state processing (inbound).
 *
 * Parses raw WsEnvelope frames into the strongly typed shared model
 * (GameState / Player / TrackDefinition) and keeps the bot's in-memory
 * snapshot up to date. Emits high-level events ("it's your turn") that the
 * entry point wires to the BotBrain — no socket or pathfinding code here.
 *
 * Server contract (host-authoritative relay architecture):
 *   inbound  JOIN_PENDING / PLAYER_APPROVED  → lobby / identity lifecycle
 *   inbound  RELAY { type, state: GameState } → full authoritative snapshot
 *   inbound  PLAYER_REJOINED                  → our connectionId was remapped
 */
import {
  GameState,
  Player,
  PlayerRejoinedPayload,
  RelayPayload,
  TrackDefinition,
  WsEnvelope,
  canPlayerMove,
} from '../../shared/ws-types';
import { getTrackById } from '../../shared/tracks';
import { log, logError } from './logger';

export interface BotIdentity {
  connectionId: string;
  roomCode: string;
  nickname: string;
}

export interface TurnContext {
  state: GameState;
  me: Player;
  track: TrackDefinition;
  opponents: Player[];
}

export interface StateEvents {
  /** Fired once the host approves the bot into the room. */
  onApproved?: () => void;
  /** Fired whenever a new snapshot says the bot may submit a move. */
  onMyTurn?: (ctx: TurnContext) => void;
  /** Fired when the race ends. */
  onGameOver?: (state: GameState) => void;
  /** Fired when the server rejects the join or errors out. */
  onFatal?: (message: string) => void;
}

export class GameStateStore {
  private identity: BotIdentity | null = null;
  private state: GameState | null = null;

  constructor(private readonly events: StateEvents) {}

  get me(): BotIdentity | null {
    return this.identity;
  }

  get snapshot(): GameState | null {
    return this.state;
  }

  /** Route one inbound envelope into the typed store. */
  handleEnvelope(envelope: WsEnvelope): void {
    switch (envelope.action) {
      case 'JOIN_PENDING': {
        // First JOIN_PENDING addressed to us carries our connectionId.
        const p = envelope.payload as { connectionId: string; roomCode: string; nickname: string; pending?: boolean };
        if (!p.pending && !this.identity) {
          this.identity = { connectionId: p.connectionId, roomCode: p.roomCode, nickname: p.nickname };
          log('LOBBY', `waiting for host approval as ${p.nickname} (${p.connectionId})`);
        }
        break;
      }

      case 'PLAYER_APPROVED': {
        const p = envelope.payload as { connectionId: string };
        if (p.connectionId === this.identity?.connectionId) {
          log('LOBBY', 'approved by host — waiting for the race to start');
          this.events.onApproved?.();
        }
        break;
      }

      case 'PLAYER_REJOINED': {
        // After a socket drop + rejoin the server hands us a new connectionId.
        const p = envelope.payload as PlayerRejoinedPayload;
        if (this.identity && p.oldConnectionId === this.identity.connectionId) {
          this.identity = { ...this.identity, connectionId: p.newConnectionId };
          log('LOBBY', `connectionId remapped to ${p.newConnectionId}`);
        }
        break;
      }

      case 'ROOM_REJOINED': {
        const p = envelope.payload as { connectionId: string; roomCode: string; nickname: string };
        this.identity = { connectionId: p.connectionId, roomCode: p.roomCode, nickname: p.nickname };
        log('LOBBY', `rejoined room ${p.roomCode} as ${p.connectionId}`);
        break;
      }

      case 'JOIN_REJECTED':
        this.events.onFatal?.('host rejected the join request');
        break;

      case 'ERROR': {
        const p = envelope.payload as { message?: string };
        logError('SERVER ERROR', p?.message ?? 'unknown');
        break;
      }

      case 'RELAY':
        this.applyRelay(envelope.payload as RelayPayload);
        break;

      default:
        break;
    }
  }

  /**
   * Adopt the authoritative snapshot, then decide whether the bot must act.
   * All turn logic reuses the shared rules (canPlayerMove) so the bot and the
   * host can never disagree about whose turn it is.
   */
  private applyRelay(relay: RelayPayload): void {
    if (!relay?.state) return;
    this.state = relay.state;
    const myId = this.identity?.connectionId;
    if (!myId) return;

    log('STATE', `type=${relay.type} phase=${this.state.phase} round=${this.state.round}`);

    if (this.state.phase === 'GAME_OVER') {
      this.events.onGameOver?.(this.state);
      return;
    }

    if (!canPlayerMove(this.state, myId)) return;

    const me = this.state.players.find((p) => p.connectionId === myId);
    const track = getTrackById(this.state.trackId);
    if (!me || !track) {
      logError('STATE', `cannot act: player or track missing (trackId=${this.state.trackId})`);
      return;
    }

    this.events.onMyTurn?.({
      state: this.state,
      me,
      track,
      opponents: this.state.players.filter((p) => p.connectionId !== myId),
    });
  }
}
