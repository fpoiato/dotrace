import { LEGACY_CONSUMER } from '../../lib/contract';

export interface Lease {
  consumer: string;
  generation: number;
  desired: string;
}

export interface LegacyControl {
  generation: number;
  desired: string;
}

/**
 * Dot Race rule, kept as-is: stop only when this request is still the latest,
 * the caller asked for stopped, and nobody is connected.
 */
export function stopStillValid(input: {
  eventGeneration: number;
  currentGeneration: number;
  desired: string;
  liveSockets: number;
}): boolean {
  return (
    input.eventGeneration === input.currentGeneration &&
    input.desired === 'stopped' &&
    input.liveSockets === 0
  );
}

export function requesterIsIdle(input: {
  /** True when the event omitted `consumer` (Dot Race's current payload). */
  legacy: boolean;
  eventGeneration: number | undefined;
  legacyControl?: LegacyControl;
  liveSockets: number;
  ownLease?: Lease;
}): boolean {
  if (input.ownLease?.desired === 'running') return false;
  if (input.legacy) {
    if (input.eventGeneration === undefined) return false;
    return stopStillValid({
      eventGeneration: input.eventGeneration,
      currentGeneration: input.legacyControl?.generation ?? -1,
      desired: input.legacyControl?.desired ?? '',
      liveSockets: input.liveSockets,
    });
  }
  if (!input.ownLease || input.eventGeneration === undefined) return false;
  return (
    input.ownLease.desired === 'stopped' && input.ownLease.generation === input.eventGeneration
  );
}

/** Consumers that still need the machine, excluding the one asking to stop. */
export function otherActiveConsumers(input: {
  requester: string;
  leases: Lease[];
  legacyActive: boolean;
}): string[] {
  const active = new Set<string>();
  for (const lease of input.leases) {
    if (lease.desired === 'running') active.add(lease.consumer);
  }
  if (input.legacyActive) active.add(LEGACY_CONSUMER);
  active.delete(input.requester);
  return [...active].sort();
}

export function legacyIsActive(control: LegacyControl | undefined, liveSockets: number): boolean {
  if (liveSockets > 0) return true;
  return control?.desired === 'running';
}

export function shouldStop(requesterIdle: boolean, othersActive: readonly string[]): boolean {
  return requesterIdle && othersActive.length === 0;
}
