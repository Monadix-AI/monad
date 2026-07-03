import type { NativeCliObservationEvent, NativeCliProvider } from '@monad/protocol';

import { claudeRecordEvents, isClaudeObservationMessage } from './native-cli-observation-claude.ts';
import {
  codexAppServerRecordEvents,
  codexExecRecordEvents,
  isCodexObservationNotification
} from './native-cli-observation-codex.ts';
import { geminiRecordEvents } from './native-cli-observation-gemini.ts';
import { jsonRecordEntries, observation, resultMarkerText, textValue } from './native-cli-observation-shared.ts';

type NativeCliObservationStreamItem = NativeCliObservationEvent;

function rawJsonObservation(
  id: string,
  rawLine: string,
  record: Record<string, unknown>,
  recordIndex: number
): NativeCliObservationEvent[] {
  return observation({
    id: `${id}:json:${recordIndex}:raw`,
    role: 'system',
    text: rawLine,
    source: 'unknown',
    providerEventType: 'raw_json',
    raw: record,
    preserveWhitespace: true
  });
}

function unknownJsonRpcError(
  id: string,
  record: Record<string, unknown>,
  recordIndex: number
): NativeCliObservationEvent[] {
  if (record.error && typeof record.error === 'object' && !Array.isArray(record.error)) {
    const error = record.error as Record<string, unknown>;
    return observation({
      id: `${id}:json:${recordIndex}:error`,
      role: 'system',
      text: textValue(error.message, error.code) ?? JSON.stringify(error),
      source: 'unknown',
      providerEventType: 'error',
      raw: record
    });
  }
  return [];
}

function recordEvents(
  id: string,
  provider: NativeCliProvider | string | undefined,
  record: Record<string, unknown>,
  recordIndex: number
): NativeCliObservationEvent[] {
  if (isCodexObservationNotification(record)) {
    const appServer = codexAppServerRecordEvents(id, record, recordIndex);
    if (appServer.length > 0) return appServer;
  }
  if (provider === 'codex') {
    const codex = codexExecRecordEvents(id, record, recordIndex);
    if (codex.length > 0) return codex;
  }
  if (provider === 'claude-code' && isClaudeObservationMessage(record)) {
    const claude = claudeRecordEvents(id, record, recordIndex);
    if (claude.length > 0) return claude;
  }
  if (provider === 'gemini') {
    const gemini = geminiRecordEvents(id, record, recordIndex);
    if (gemini.length > 0) return gemini;
  }
  return [
    ...codexExecRecordEvents(id, record, recordIndex),
    ...(isClaudeObservationMessage(record) ? claudeRecordEvents(id, record, recordIndex) : []),
    ...geminiRecordEvents(id, record, recordIndex),
    ...unknownJsonRpcError(id, record, recordIndex)
  ];
}

function parsedJsonEvents(args: {
  id: string;
  provider?: NativeCliProvider | string;
  entries: { record: Record<string, unknown>; raw: string }[];
}): NativeCliObservationEvent[] {
  return args.entries.flatMap((entry, index) => {
    const events = recordEvents(args.id, args.provider, entry.record, index);
    if (events.length > 0) return events;
    return rawJsonObservation(args.id, entry.raw, entry.record, index);
  });
}

function removeAdjacentDuplicateObservations(events: NativeCliObservationEvent[]): NativeCliObservationEvent[] {
  const out: NativeCliObservationEvent[] = [];
  for (const event of events) {
    const previous = out.at(-1);
    if (
      previous &&
      previous.role === event.role &&
      previous.source === event.source &&
      previous.text.trim() === event.text.trim()
    ) {
      // A result whose text just repeats the assistant message it settles still marks a
      // query boundary — keep it as a compact marker instead of dropping it outright.
      if (
        event.providerEventType === 'result' &&
        event.raw &&
        typeof event.raw === 'object' &&
        !Array.isArray(event.raw)
      ) {
        out.push({ ...event, text: resultMarkerText(event.raw as Record<string, unknown>) });
      }
      continue;
    }
    out.push(event);
  }
  return out;
}

function isChunkObservation(event: NativeCliObservationEvent): boolean {
  return event.providerEventType?.endsWith('/delta') === true || event.providerEventType?.endsWith('Delta') === true;
}

// Streaming deltas are emitted to be concatenated verbatim: each already carries its own
// boundary whitespace (codex sends " the", " CLI"; a mid-word split sends "impl" then
// "ementation"). Guessing a space between two alphanumeric edges corrupts both cases —
// it inserts a spurious space inside a split word and, worse, between CJK characters that
// never take inter-character spaces (我来 + 先做 → "我来 先做"). Always join verbatim,
// accumulating a run's fragments and joining once so folding k deltas stays O(k).
function mergeAdjacentChunkObservations(events: NativeCliObservationEvent[]): NativeCliObservationEvent[] {
  const out: NativeCliObservationEvent[] = [];
  let runTexts: string[] = [];
  let runRaws: unknown[] = [];
  const settleRun = () => {
    if (runTexts.length < 2) return;
    const previous = out.at(-1);
    if (previous) out[out.length - 1] = { ...previous, text: runTexts.join(''), raw: runRaws };
  };
  for (const event of events) {
    const previous = out.at(-1);
    if (
      previous &&
      isChunkObservation(previous) &&
      isChunkObservation(event) &&
      previous.role === event.role &&
      previous.source === event.source &&
      previous.providerEventType === event.providerEventType
    ) {
      runTexts.push(event.text);
      runRaws.push(event.raw);
      continue;
    }
    settleRun();
    out.push(event);
    runTexts = isChunkObservation(event) ? [event.text] : [];
    runRaws = isChunkObservation(event) ? [event.raw] : [];
  }
  settleRun();
  // Deltas were kept verbatim to preserve internal boundary whitespace; trim the
  // outer edges of each merged block and drop chunks that were whitespace-only.
  return out.flatMap((event) => {
    if (!isChunkObservation(event)) return [event];
    const text = event.text.trim();
    return text ? [{ ...event, text }] : [];
  });
}

function nativeCliObservationEvents(args: {
  id: string;
  provider?: NativeCliProvider | string;
  output?: string;
}): NativeCliObservationEvent[] | undefined {
  const text = args.output?.trim();
  if (!text) return [];
  const entries = jsonRecordEntries(text);
  if (entries.length > 0) {
    return removeAdjacentDuplicateObservations(
      mergeAdjacentChunkObservations(parsedJsonEvents({ id: args.id, provider: args.provider, entries }))
    );
  }
  return undefined;
}

export function nativeCliStreamItems(args: {
  id: string;
  provider?: NativeCliProvider | string;
  output?: string;
}): NativeCliObservationStreamItem[] {
  const text = args.output?.trim();
  if (!text) return [];
  const structured = nativeCliObservationEvents(args);
  if (structured) return structured;
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => ({
      id: `${args.id}:${index}`,
      role: part.startsWith('tool:') ? ('tool' as const) : ('agent' as const),
      text: part,
      source: 'plain-text' as const
    }));
}
