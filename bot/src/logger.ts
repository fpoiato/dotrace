/** Tiny tagged console logger so connection/turn events are easy to grep. */
export function log(tag: string, ...args: unknown[]): void {
  console.log(`${new Date().toISOString()} [${tag}]`, ...args);
}

export function logError(tag: string, ...args: unknown[]): void {
  console.error(`${new Date().toISOString()} [${tag}]`, ...args);
}
