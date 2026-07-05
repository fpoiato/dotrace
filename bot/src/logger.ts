type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Tiny leveled console logger. The connection layer uses the bracketed tags
 * required by the spec (`[CONNECTED]`, `[DISCONNECTED]`, `[MESSAGE RECEIVED]`).
 */
export class Logger {
  constructor(private readonly min: Level = 'info') {}

  private stamp(): string {
    return new Date().toISOString();
  }

  private log(level: Level, tag: string, ...args: unknown[]): void {
    if (ORDER[level] < ORDER[this.min]) return;
    const line = `${this.stamp()} ${tag}`;
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    sink(line, ...args);
  }

  debug(tag: string, ...args: unknown[]): void {
    this.log('debug', tag, ...args);
  }
  info(tag: string, ...args: unknown[]): void {
    this.log('info', tag, ...args);
  }
  warn(tag: string, ...args: unknown[]): void {
    this.log('warn', tag, ...args);
  }
  error(tag: string, ...args: unknown[]): void {
    this.log('error', tag, ...args);
  }
}
