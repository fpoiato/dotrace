import type { ClientAction, WsEnvelope } from '../../shared/ws-types';

/**
 * HTTP command client — posts game/lobby actions with the live WebSocket connectionId.
 */
export class HttpClient {
  constructor(private readonly apiUrl: string) {}

  async postAction<T = unknown>(
    action: ClientAction,
    payload: unknown,
    connectionId: string,
    roomCode?: string
  ): Promise<WsEnvelope<T>> {
    const response = await fetch(`${this.apiUrl}/actions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Connection-Id': connectionId,
      },
      body: JSON.stringify({ action, payload, roomCode, connectionId }),
    });

    const body = (await response.json()) as WsEnvelope<T>;
    if (!response.ok || body.action === 'ERROR') {
      const message =
        (body.payload as { message?: string } | undefined)?.message ??
        `HTTP ${response.status}`;
      throw new Error(message);
    }
    return body;
  }
}
