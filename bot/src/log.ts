/** Tiny tagged console logger so every subsystem event is greppable. */

export type LogTag =
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'RECONNECTING'
  | 'MESSAGE RECEIVED'
  | 'MESSAGE SENT'
  | 'STATE'
  | 'BRAIN'
  | 'MOVE'
  | 'ERROR'
  | 'INFO';

export function log(tag: LogTag, message: string, detail?: unknown): void {
  const stamp = new Date().toISOString();
  if (detail !== undefined) {
    console.log(`${stamp} [${tag}] ${message}`, detail);
  } else {
    console.log(`${stamp} [${tag}] ${message}`);
  }
}
