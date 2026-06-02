import type { AgentObservationEvent } from '@monad/protocol';

function rawEventsFromContractEvent(contractEvent: unknown): unknown[] {
  if (!contractEvent || typeof contractEvent !== 'object' || Array.isArray(contractEvent)) return [contractEvent];
  const provenance = (contractEvent as { provenance?: unknown }).provenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return [contractEvent];
  const rawEvents = (provenance as { rawEvents?: unknown }).rawEvents;
  return Array.isArray(rawEvents) && rawEvents.length > 0 ? rawEvents : [contractEvent];
}

export function observationContractRawEvents(contractEvents: readonly unknown[]): unknown[] {
  const seen = new Set<unknown>();
  return contractEvents.flatMap(rawEventsFromContractEvent).filter((rawEvent) => {
    if (seen.has(rawEvent)) return false;
    seen.add(rawEvent);
    return true;
  });
}

export function observationRawEvents(event: Pick<AgentObservationEvent, 'provenance'>): unknown[] {
  return observationContractRawEvents(event.provenance.contractEvents);
}
