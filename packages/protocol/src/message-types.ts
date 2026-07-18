import { z } from 'zod';

import { httpUrlSchema } from './url.ts';

export { isHttpUrl } from './url.ts';

// The message-type registry: the single shared source describing how each `type` renders, degrades,
// and participates in the LLM context. Read by the daemon (enforcement), the store (defaults), and
// every UI client / channel adapter (degradation). Holds descriptor DATA only — never render
// components, which live in the UI packages keyed by `type`.

/** A representation a renderer can target, in degradation order. `text` is always the terminal step. */
export type MessageRepresentation = 'data' | 'markdown' | 'text';

/** An interaction a rich `type` may expose; a client renders `data` only if it supports all of them. */
export type MessageInteraction = 'buttons' | 'form' | 'links' | 'media';

export interface MessageTypeDescriptor<D = unknown> {
  type: string;
  /** Validates `data` for this type at the daemon boundary; `z.unknown()` for opaque payloads. */
  dataSchema: z.ZodType<D>;
  /** Ordered chain a renderer walks until it finds a form it can render. Always ends at `text`. */
  fallbacks: ReadonlyArray<MessageRepresentation>;
  /** Interaction capabilities the rich form CAN expose. */
  interactions?: ReadonlyArray<MessageInteraction>;
  /** Default: does a message of this type enter the LLM context (prompt + token stats + summary)? */
  includeInContext: boolean;
  /** True if produced by generation (carries a `stream` lifecycle). */
  generative?: boolean;
}

// The built-in `card` data contract. A rich client renders title/body/actions; a thin one degrades
// to the text fallback. Kept small and presentational — no arbitrary HTML.
// Card data is model-produced (attacker-controlled via prompt injection) and a client renders the
// action URL as an <a href>. `z.url()` alone accepts `javascript:`/`data:` schemes, which React does
// NOT block — that is clickable XSS in the trusted web origin. Constrain to http(s) at the boundary.
// Single source of truth for the scheme allowlist: the wire schema and every render boundary
// (e.g. apps/web's card renderer) import this so they can't drift apart.
export const cardActionSchema = z.object({ label: z.string().min(1), url: httpUrlSchema.optional() });
export const cardSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  actions: z.array(cardActionSchema).max(8).optional()
});
export type Card = z.infer<typeof cardSchema>;

export const branchSourceSchema = z.object({
  sessionTitle: z.string().optional()
});
export type BranchSource = z.infer<typeof branchSourceSchema>;

export const providerConfigErrorSchema = z.object({
  providerId: z.string().optional()
});
export type ProviderConfigError = z.infer<typeof providerConfigErrorSchema>;

export const BUILTIN_MESSAGE_TYPES: Record<string, MessageTypeDescriptor> = Object.freeze({
  text: { type: 'text', dataSchema: z.unknown(), fallbacks: ['text'], includeInContext: true },
  markdown: { type: 'markdown', dataSchema: z.unknown(), fallbacks: ['markdown', 'text'], includeInContext: true },
  // Tool rows carry structured `data`, but the web renders them through a dedicated paired
  // ToolStepView (not the registry/MessageBody path), so via pickRepresentation they degrade to text.
  tool_call: { type: 'tool_call', dataSchema: z.unknown(), fallbacks: ['text'], includeInContext: true },
  tool_result: { type: 'tool_result', dataSchema: z.unknown(), fallbacks: ['text'], includeInContext: true },
  card: {
    type: 'card',
    dataSchema: cardSchema,
    fallbacks: ['data', 'markdown', 'text'],
    interactions: ['buttons', 'links'],
    includeInContext: true,
    generative: true
  },
  // UI-only: a host slash-command echo with no model call — never replayed, counted, or summarized.
  directive: { type: 'directive', dataSchema: z.unknown(), fallbacks: ['text'], includeInContext: false },
  branch_source: {
    type: 'branch_source',
    dataSchema: branchSourceSchema,
    fallbacks: ['data', 'text'],
    includeInContext: false
  },
  // UI-only: a surfaced failure — never replayed, counted, or summarized.
  error: { type: 'error', dataSchema: z.unknown(), fallbacks: ['text'], includeInContext: false },
  // UI-only: a generation failure specifically caused by provider/credential setup (missing
  // credentials, or the provider doesn't support the requested capability) — never replayed,
  // counted, or summarized. Renders a dedicated card pointing at provider settings.
  provider_config_error: {
    type: 'provider_config_error',
    dataSchema: providerConfigErrorSchema,
    fallbacks: ['data', 'text'],
    includeInContext: false
  }
});

/** Unknown / unregistered types degrade to text and keep the historical pass-through behaviour
 * (their benign `text` fallback enters context). An atom pack that wants richer handling must register. */
export const UNKNOWN_TYPE_DESCRIPTOR: MessageTypeDescriptor = {
  type: '*',
  dataSchema: z.unknown(),
  fallbacks: ['markdown', 'text'],
  includeInContext: true
};

const atomTypes = new Map<string, MessageTypeDescriptor>();

/** Register an atom-owned message type under a `atomId:type` namespace. The namespace makes
 * shadowing a built-in impossible (built-in keys are unprefixed); registering the same namespaced
 * type twice throws so an atom can't silently clobber an already-loaded one. */
export function registerMessageType(atomPackId: string, d: MessageTypeDescriptor): MessageTypeDescriptor {
  const type = `${atomPackId}:${d.type}`;
  if (type in BUILTIN_MESSAGE_TYPES || atomTypes.has(type)) {
    throw new Error(`message type already registered: ${type}`);
  }
  const namespaced = { ...d, type };
  atomTypes.set(type, namespaced);
  return namespaced;
}

/** Test/teardown hook: drop an atom type registration. */
export function unregisterMessageType(type: string): void {
  atomTypes.delete(type);
}

export function resolveMessageType(type: string): MessageTypeDescriptor {
  return BUILTIN_MESSAGE_TYPES[type] ?? atomTypes.get(type) ?? UNKNOWN_TYPE_DESCRIPTOR;
}

/** The effective context policy for a message: per-message override wins over the type default. */
export function includeInContext(m: { type?: string; includeInContext?: boolean }): boolean {
  return m.includeInContext ?? resolveMessageType(m.type ?? 'text').includeInContext;
}

/** The `includeInContext` value to persist when inserting a message — `undefined` ⇒ store NULL and
 * resolve the default live at read. An explicit override always wins. Otherwise a REGISTERED ATOM PACK
 * type's policy is snapshotted so it stays correct even if that atom pack later isn't loaded (a bare
 * `resolveMessageType` would then fall back to the unknown default and wrongly re-include it);
 * built-in and unknown types persist nothing, keeping the common case sparse. */
export function persistedIncludeInContext(type: string, override: boolean | undefined): boolean | undefined {
  if (override !== undefined) return override;
  if (atomTypes.has(type)) return resolveMessageType(type).includeInContext;
  return undefined;
}

/** Validate a message's `data` against its type's schema at a trust boundary (atom- or
 * agent-produced rich messages). Built-in opaque types (`z.unknown()`) always pass. */
export function validateMessageData(
  type: string,
  data: unknown
): { ok: true; data: unknown } | { ok: false; error: string } {
  const r = resolveMessageType(type).dataSchema.safeParse(data);
  return r.success ? { ok: true, data: r.data } : { ok: false, error: r.error.message };
}

/** What a renderer can do. Used by both our own UI clients (client-side) and a channel adapter
 * (server-side) to pick a representation — the single shared degradation computation. */
export interface ClientRenderCaps {
  /** Types this client owns a rich `data` renderer for. */
  richTypes?: ReadonlySet<string>;
  /** Can render markdown (vs plain text only). */
  markdown?: boolean;
  /** Interaction capabilities the client supports. */
  interactions?: ReadonlySet<MessageInteraction>;
}

/** Walk a type's degradation chain and return the richest representation `caps` supports.
 * Always terminates at `'text'` (the guaranteed fallback the server always populates). */
export function pickRepresentation(type: string, caps: ClientRenderCaps): MessageRepresentation {
  const d = resolveMessageType(type);
  for (const rep of d.fallbacks) {
    if (rep === 'text') break;
    if (rep === 'markdown' && caps.markdown) return 'markdown';
    if (rep === 'data') {
      const hasRenderer = caps.richTypes?.has(type) ?? false;
      const interactionsOk = (d.interactions ?? []).every((i) => caps.interactions?.has(i) ?? false);
      if (hasRenderer && interactionsOk) return 'data';
    }
  }
  return 'text';
}
