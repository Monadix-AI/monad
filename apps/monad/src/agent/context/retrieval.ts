// RetrievalReinjectionContext — the optional final cascade stage. Eviction and summarization shrink
// the SENT window, but the store always keeps every message's ORIGINAL text regardless of what a
// turn actually sends — eviction only rewrites the in-memory prompt, and summarization only changes
// which rows get loaded (see history.ts / eviction.ts). That means a semantic search over this
// session's full message history can recover exactly what those lossy/lossless stages just hid,
// when the current turn turns out to need it again.
//
// Runs AFTER eviction, BEFORE the hard TokenLimiterContext guard, so injected hits still respect the
// hard cap. Snippets are pre-truncated (`store.searchSemantic`, ~80 chars) so even the max result
// count adds only a small, bounded amount of text — this is a targeted nudge, not a second copy of
// history.

import type { ModelMessage } from '../model/index.ts';
import type { ContextEngine, ContextPrepareCtx } from './index.ts';

interface RetrievalHit {
  messageId: string;
  snippet: string;
  score: number;
}

export interface RetrievalReinjectionOptions {
  /** Embeds a single query string. Resolves to undefined when embedding is unavailable/disabled —
   *  the stage then no-ops rather than failing the turn. Must not throw for a config-off provider;
   *  prepare() also tolerates a throw as a safety net. */
  embed: (text: string) => Promise<number[] | undefined>;
  /** Session-scoped semantic search over ALL persisted messages, best-first. */
  search: (sessionId: string, queryVec: number[], limit: number) => RetrievalHit[];
  /** Only splice hits at/above this cosine similarity. Default 0.7. */
  minScore?: number;
  /** Max hits spliced in per turn. Default 3. */
  maxResults?: number;
}

function lastUserIndex(messages: ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === 'user') return i;
  return -1;
}

function textOf(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join(' ');
}

export class RetrievalReinjectionContext implements ContextEngine {
  private readonly minScore: number;
  private readonly maxResults: number;

  constructor(private readonly opts: RetrievalReinjectionOptions) {
    this.minScore = opts.minScore ?? 0.7;
    this.maxResults = opts.maxResults ?? 3;
  }

  async prepare(messages: ModelMessage[], ctx?: ContextPrepareCtx): Promise<ModelMessage[]> {
    const sessionId = ctx?.sessionId;
    if (!sessionId || this.maxResults <= 0) return messages;
    const idx = lastUserIndex(messages);
    if (idx === -1) return messages;
    const query = textOf((messages[idx] as ModelMessage).content).trim();
    if (!query) return messages;

    let vec: number[] | undefined;
    try {
      vec = await this.opts.embed(query);
    } catch {
      return messages; // best-effort — a retrieval hiccup must never fail the turn
    }
    if (!vec || vec.length === 0) return messages;

    const hits = this.opts.search(sessionId, vec, this.maxResults).filter((h) => h.score >= this.minScore);
    if (hits.length === 0) return messages;

    const block = [
      '<related_context>',
      'Semantically related content from earlier in this session (may be paraphrased, summarized, or cleared from the context above):',
      ...hits.map((h) => `- ${h.snippet}`),
      '</related_context>'
    ].join('\n');

    const next = [...messages];
    const target = next[idx] as ModelMessage;
    next[idx] =
      typeof target.content === 'string'
        ? { ...target, content: `${target.content}\n\n${block}` }
        : { ...target, content: [...target.content, { type: 'text', text: `\n\n${block}` }] };
    return next;
  }
}
