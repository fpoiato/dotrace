export function ok(): { statusCode: number; body: string } {
  return { statusCode: 200, body: 'OK' };
}

export interface WsEnvelope {
  action?: string;
  payload?: unknown;
  roomCode?: string;
}

export function parseBody<T>(event: { body?: string | null }): T | undefined {
  if (!event.body) return undefined;
  try {
    return JSON.parse(event.body) as T;
  } catch {
    return undefined;
  }
}
