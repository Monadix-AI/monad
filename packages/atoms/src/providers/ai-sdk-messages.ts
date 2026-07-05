import type { ModelCall, ModelContentPart, ToolSpec } from '@monad/sdk-atom';
import type { ModelMessage as SdkMessage } from 'ai';

/** Plain-text projection of a request for a native count-tokens call. */
export interface CountTokensInput {
  system?: string;
  text: string;
  tools?: ToolSpec[];
}

// The AI SDK requires system prompts via its dedicated `system` option — inline system messages
// in `messages` are flagged as a prompt-injection risk. A `cache`-marked system message is emitted
// as a leading message carrying an Anthropic cache breakpoint (other providers ignore it).
export function splitSystem(messages: ModelMessageLike[]): {
  system?: string;
  messages: SdkMessage[];
  allowSystemInMessages?: boolean;
} {
  const sysMsg = messages.find((m) => m.role === 'system');
  const sysText = typeof sysMsg?.content === 'string' ? sysMsg.content : undefined;
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map(toSdkPart)
    })) as SdkMessage[];

  if (sysMsg?.cache && sysText !== undefined) {
    const cachedSystem = {
      role: 'system',
      content: sysText,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }
    } as unknown as SdkMessage;
    return { messages: [cachedSystem, ...rest], allowSystemInMessages: true };
  }
  return { system: sysText, messages: rest };
}

type ModelMessageLike = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ModelContentPart[];
  cache?: boolean;
};

function toSdkPart(p: ModelContentPart) {
  switch (p.type) {
    case 'text':
      return { type: 'text' as const, text: p.text };
    case 'image':
      return { type: 'image' as const, image: p.image, ...(p.mediaType ? { mediaType: p.mediaType } : {}) };
    case 'tool-call':
      return { type: 'tool-call' as const, toolCallId: p.toolCallId, toolName: p.toolName, input: p.input };
    case 'tool-result':
      return {
        type: 'tool-result' as const,
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        output: { type: 'text' as const, value: p.output }
      };
  }
}

/** Project a neutral message list to {system, text, tools} for a native count-tokens call. */
export function renderForCount(call: ModelCall): CountTokensInput {
  let system: string | undefined;
  const parts: string[] = [];
  for (const m of call.messages) {
    const text = renderCountContent(m.content);
    if (m.role === 'system') system = system === undefined ? text : `${system}\n${text}`;
    else if (text) parts.push(text);
  }
  return { system, text: parts.join('\n'), ...(call.tools ? { tools: call.tools } : {}) };
}

function renderCountContent(content: string | ModelContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((p) => {
      switch (p.type) {
        case 'text':
          return p.text;
        case 'tool-call':
          return typeof p.input === 'string' ? p.input : JSON.stringify(p.input);
        case 'tool-result':
          return p.output;
        case 'image':
          return '';
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}
