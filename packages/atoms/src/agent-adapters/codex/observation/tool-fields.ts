import type { MeshAgentObservationEvent, MeshAgentObservationTool } from '@monad/protocol';

import { recordValue } from '../../shared/observation/observation-projection.ts';
import {
  codexAppServerToolInput,
  codexAppServerToolOutput,
  codexItemToolFields
} from './observation-app-server-tool.ts';

/** A raw slice that IS the provider item (as history pages project it) rather than the JSON-RPC
 *  envelope wrapping one (as live notifications deliver it): its declared id sits at the top level. */
function isBareItem(raw: Record<string, unknown> | undefined): raw is Record<string, unknown> {
  return typeof raw?.id === 'string' && typeof raw.type === 'string' && raw.method === undefined;
}

/** Recover the tool fields from a Codex record whose event was projected without them — a history
 *  page replayed through a different entry point, or a run reconciled after the fact. */
export function codexObservationToolFields(
  event: MeshAgentObservationEvent,
  kind: 'tool-call' | 'tool-result'
): MeshAgentObservationTool | undefined {
  const rawRecords = event.provenance.rawEvents
    .map((value) => recordValue(value))
    .filter((value): value is Record<string, unknown> => value !== undefined);
  const raw = rawRecords[0];
  const item = recordValue(recordValue(raw?.params)?.item) ?? recordValue(raw?.item) ?? rawRecords.find(isBareItem);
  if (!item) return undefined;
  const input = codexAppServerToolInput(item);
  const output = kind === 'tool-result' ? codexAppServerToolOutput(item) : undefined;
  return {
    ...codexItemToolFields(item),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output })
  };
}
