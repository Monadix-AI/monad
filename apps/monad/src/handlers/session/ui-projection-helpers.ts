import type {
  ChatMessage,
  MeshSessionId,
  UIItem,
  UIMessageItem,
  UIPart,
  UIQuestionPresentation
} from '@monad/protocol';

import { channelDisplayText, channelStructuredVisibility, uiQuestionPresentationSchema } from '@monad/protocol';
import { Allow, parse as parsePartialJson } from 'partial-json';

const TEXT_TYPES = new Set(['text', 'markdown', 'error']);
// Min chars to accumulate before re-running the O(current-length) channel partial-JSON parse. Parses
// also fire whenever a delta carries a `}` (a structural close — end of the display/visibility object),
// so completion and `silent` flips are never missed regardless of this throttle.
export const CHANNEL_REPARSE_MIN_DELTA = 32;

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

export function statusFromMessage(message: ChatMessage): UIMessageItem['status'] {
  if (message.type === 'error') return 'error';
  return message.stream?.status === 'pending' || message.stream?.status === 'streaming' ? 'streaming' : 'done';
}

export function questionPresentationFromMessage(message: ChatMessage): UIQuestionPresentation | undefined {
  if (message.role !== 'assistant' || !message.data || typeof message.data !== 'object') return undefined;
  const data = message.data as Record<string, unknown>;
  if (data.kind !== 'project-qa') return undefined;
  const parsed = uiQuestionPresentationSchema.safeParse({ question: data.question, options: data.options });
  return parsed.success ? parsed.data : undefined;
}

export function projectQaAnswerItem(message: ChatMessage, questionItem?: UIMessageItem): UIMessageItem | undefined {
  const data = message.data && typeof message.data === 'object' ? (message.data as Record<string, unknown>) : undefined;
  if (message.role !== 'system' || data?.source !== 'managed-mesh-agent-question') return undefined;
  const requestId = data.requestId;
  if (typeof requestId !== 'string' || !requestId) return undefined;
  const answerMarker = '\nUser answer: ';
  const answerStart = message.text.indexOf(answerMarker);
  const answerEnd = answerStart < 0 ? -1 : message.text.indexOf('\n\n', answerStart + answerMarker.length);
  const legacyAnswer =
    answerStart < 0
      ? undefined
      : message.text.slice(answerStart + answerMarker.length, answerEnd < 0 ? undefined : answerEnd).trim();
  const answer = typeof data.answer === 'string' ? data.answer.trim() : legacyAnswer;
  if (!answer) return undefined;
  if (questionItem?.question) {
    return {
      ...questionItem,
      question: { ...questionItem.question, answer },
      status: 'done'
    };
  }
  const questionPresentation = uiQuestionPresentationSchema.safeParse({
    question: data.question,
    options: data.options,
    answer
  });
  const questionMessageId = projectQaQuestionMessageId(message);
  if (questionMessageId && questionPresentation.success) {
    const optionsText = questionPresentation.data.options.length
      ? `\nOptions: ${questionPresentation.data.options.join(' | ')}`
      : '';
    const askerName = typeof data.askerName === 'string' && data.askerName ? data.askerName : undefined;
    return {
      kind: 'message',
      id: questionMessageId,
      role: 'assistant',
      ...(askerName ? { agentName: askerName } : {}),
      parts: [{ type: 'text', text: `Q: ${questionPresentation.data.question}${optionsText}` }],
      question: questionPresentation.data,
      replyable: false,
      status: 'done',
      seq: message.createdAt
    };
  }
  return {
    kind: 'message',
    id: `clarify-answer:${requestId}`,
    role: 'user',
    parts: [{ type: 'text', text: answer }],
    replyable: false,
    status: 'done',
    seq: message.createdAt
  };
}

export function projectQaQuestionMessageId(message: ChatMessage): string | undefined {
  if (message.role !== 'system' || !message.data || typeof message.data !== 'object') return undefined;
  const data = message.data as Record<string, unknown>;
  if (data.source !== 'managed-mesh-agent-question') return undefined;
  return typeof data.questionMessageId === 'string' && data.questionMessageId ? data.questionMessageId : undefined;
}

export function partsFromMessage(message: ChatMessage, opts: { channelStructured?: boolean } = {}): UIPart[] {
  const text = opts.channelStructured && message.role === 'assistant' ? channelDisplayText(message.text) : message.text;
  const parts: UIPart[] = [];
  const data = message.data as { reasoning?: string; attachments?: unknown; source?: string } | undefined;
  // A managed-mesh-agent wake message's streaming/"thinking" indicator is derived from its stream status
  // and localized by the experience. Persisted rows still carry a legacy hard-coded `reasoning` string
  // (e.g. "Thinking"); never resurface it as a UI part or the daemon leaks presentation copy from history.
  if (typeof data?.reasoning === 'string' && data.reasoning.length > 0 && data.source !== 'managed-mesh-agent') {
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

export function agentDisplayNameFromData(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const agentDisplayName = (data as { agentDisplayName?: unknown }).agentDisplayName;
  return typeof agentDisplayName === 'string' && agentDisplayName ? agentDisplayName : undefined;
}

export function sourceFromData(data: unknown): UIMessageItem['source'] | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const source = (data as { source?: unknown }).source;
  return source === 'managed-mesh-agent' || source === 'mesh-agent-provider' ? source : undefined;
}

export function meshSessionIdFromData(data: unknown): MeshSessionId | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const meshSessionId = (data as { meshSessionId?: unknown }).meshSessionId;
  return typeof meshSessionId === 'string' && meshSessionId.startsWith('mesh_')
    ? (meshSessionId as MeshSessionId)
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

// Hot path: invoked per canonical content delta with the full accumulated message text. A single tolerant
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
