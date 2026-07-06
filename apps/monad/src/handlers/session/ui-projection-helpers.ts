import type { ChatMessage, UIItem, UIMessageItem, UIPart } from '@monad/protocol';

import { channelDisplayText, channelStructuredVisibility } from '@monad/protocol';
import { Allow, parse as parsePartialJson } from 'partial-json';

const TEXT_TYPES = new Set(['text', 'markdown', 'error']);
export const MAX_NATIVE_CLI_UI_OUTPUT = 64 * 1024;
// Min chars to accumulate before re-running the O(current-length) channel partial-JSON parse. Parses
// also fire whenever a delta carries a `}` (a structural close — end of the display/visibility object),
// so completion and `silent` flips are never missed regardless of this throttle.
export const CHANNEL_REPARSE_MIN_DELTA = 32;

/** Durable per-run projection of a native CLI session, used to rebuild its tool card during
 *  hydration (page refresh / reconnect) from the bounded output snapshot rather than from the
 *  per-chunk `native_cli.output` event stream. Structurally satisfied by the store's session row. */
export interface NativeCliSessionSnapshot {
  id: string;
  provider: string;
  agentName: string;
  workingPath: string;
  launchMode: string;
  state: 'starting' | 'running' | 'exited' | 'failed' | 'stopped';
  exitCode: number | null;
  outputSnapshot: string;
  startedAt: string;
}

export function itemKey(kind: UIItem['kind'], id: string): string {
  return `${kind}:${id}`;
}

// Safe to drop from a live projector once it settles: it won't receive further deltas and the client
// keeps its own copy. Active/streaming items and pending interactions (approval/clarification) are
// never evicted — late events still target them; singletons (context) and markers are kept too.
export function isEvictable(item: UIItem): boolean {
  if (item.kind === 'message' || item.kind === 'custom') return item.status === 'done' || item.status === 'error';
  if (item.kind === 'tool') return item.status === 'ok' || item.status === 'error';
  return false;
}

export function nativeCliToolItem(s: NativeCliSessionSnapshot): Extract<UIItem, { kind: 'tool' }> {
  const status = s.state === 'failed' ? 'error' : s.state === 'starting' || s.state === 'running' ? 'running' : 'ok';
  // Mirror the live `native_cli.exited` decoration so a refreshed terminal run reads the same as one
  // watched live; keep the running state undecorated.
  const exitText = status === 'running' ? '' : s.exitCode === null ? `\n${s.state}` : `\n${s.state} (${s.exitCode})`;
  const output = appendBoundedText(s.outputSnapshot, exitText, MAX_NATIVE_CLI_UI_OUTPUT);
  return {
    kind: 'tool',
    id: s.id,
    tool: `native-cli:${s.provider}`,
    input: {
      agent: s.agentName,
      provider: s.provider,
      workingPath: s.workingPath,
      launchMode: s.launchMode,
      approvalOwnership: 'provider-owned'
    },
    ...(output ? { output } : {}),
    status,
    seq: s.startedAt
  };
}

export function statusFromMessage(message: ChatMessage): UIMessageItem['status'] {
  if (message.type === 'error') return 'error';
  return message.stream?.status === 'pending' || message.stream?.status === 'streaming' ? 'streaming' : 'done';
}

export function partsFromMessage(message: ChatMessage, opts: { channelStructured?: boolean } = {}): UIPart[] {
  const text = opts.channelStructured && message.role === 'assistant' ? channelDisplayText(message.text) : message.text;
  const parts: UIPart[] = [];
  const data = message.data as { reasoning?: string; attachments?: unknown } | undefined;
  if (typeof data?.reasoning === 'string' && data.reasoning.length > 0) {
    parts.push({ type: 'reasoning', text: data.reasoning });
  }
  if (message.type && !TEXT_TYPES.has(message.type)) {
    parts.push({
      type: 'artifact',
      messageType: message.type,
      ...(text ? { text } : {}),
      ...(message.data !== undefined ? { data: message.data } : {})
    });
  } else if (text || parts.length === 0) {
    parts.push({ type: 'text', text });
  }
  // File references shared with the message — one custom part per file so clients render a
  // download/preview chip for each below the text.
  if (Array.isArray(data?.attachments)) {
    for (const attachment of data.attachments) {
      if (attachment && typeof attachment === 'object')
        parts.push({ type: 'custom', name: 'attachment', data: attachment });
    }
  }
  return parts;
}

export function isSilentChannelMessage(message: ChatMessage, opts: { channelStructured?: boolean }): boolean {
  return Boolean(
    opts.channelStructured && message.role === 'assistant' && channelStructuredVisibility(message.text) === 'silent'
  );
}

export function agentNameFromData(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const agentName = (data as { agentName?: unknown }).agentName;
  return typeof agentName === 'string' && agentName ? agentName : undefined;
}

export function sourceFromData(data: unknown): UIMessageItem['source'] | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const source = (data as { source?: unknown }).source;
  return source === 'managed-native-cli' || source === 'native-cli-provider' ? source : undefined;
}

export function nativeCliSessionIdFromData(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const nativeCliSessionId = (data as { nativeCliSessionId?: unknown }).nativeCliSessionId;
  return typeof nativeCliSessionId === 'string' && nativeCliSessionId.startsWith('ncli_')
    ? nativeCliSessionId
    : undefined;
}

export function deliveryIdFromData(data: unknown): `deliv_${string}` | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const deliveryId = (data as { deliveryId?: unknown }).deliveryId;
  return typeof deliveryId === 'string' && deliveryId.startsWith('deliv_')
    ? (deliveryId as `deliv_${string}`)
    : undefined;
}

export function isUnknownToolResult(tool: string | undefined, output: string | undefined): boolean {
  if (!tool || !output) return false;
  return output === `unknown tool "${tool}"` || output === `Error: unknown tool "${tool}"`;
}

export function displayFromToolResultData(data: unknown): unknown {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as { display?: unknown; result?: { displayContent?: unknown } };
  return d.result && 'displayContent' in d.result ? d.result.displayContent : d.display;
}

function channelStructuredJsonText(text: string): string {
  const trimmed = text.trim();
  const completeFence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (completeFence?.[1] ?? trimmed.replace(/^```(?:json)?\s*/i, '')).trim();
}

export function appendBoundedText(current: string, chunk: string, maxBytes: number): string {
  const next = `${current}${chunk}`;
  return next.length > maxBytes ? next.slice(-maxBytes) : next;
}

// Hot path: invoked per `agent.token` with the full accumulated message text. A single tolerant
// partial-JSON parse covers both the mid-stream (incomplete) and completed-JSON cases, so we skip the
// redundant strict JSON.parse + zod safeParse that previously ran first on every token (it threw on
// every incomplete chunk and re-validated the whole object once complete). Visibility is honored here
// so a `silent` response renders nothing even before the JSON closes.
export function channelPartialDisplayText(text: string): string {
  const raw = channelStructuredJsonText(text);
  if (!raw.startsWith('{')) return '';
  try {
    const parsed = parsePartialJson(raw, Allow.STR | Allow.OBJ | Allow.ARR) as unknown;
    if (!parsed || typeof parsed !== 'object') return '';
    if ((parsed as { visibility?: unknown }).visibility === 'silent') return '';
    const display = (parsed as { display?: unknown }).display;
    if (!display || typeof display !== 'object') return '';
    const content = (display as { content?: unknown }).content;
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}
