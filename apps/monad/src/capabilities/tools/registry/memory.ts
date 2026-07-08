// memory_* — a tiny session scratchpad the agent writes explicitly, surfaced back into every later
// turn by a built-in UserPromptSubmit recall hook (see the daemon wiring). This is the hook system
// dogfooding itself: the agent captures facts via the tool; the hook auto-recalls them — the
// capture/recall split that hooks make clean. Notes are session-scoped and stored as one JSON blob
// under `agent:notes`, so the backend only needs get/set (no list-by-prefix).

import type { Tool, ToolContext, ToolInputSchema } from '#/capabilities/tools/types.ts';
import type { ToolModule } from './contract.ts';

import { toolResult } from '#/capabilities/tools/types.ts';

/** Minimal key/value backend (the daemon wires this to @monad/store's session memory). */
export interface NoteStore {
  get(sessionId: string, key: string): string | null;
  set(sessionId: string, key: string, value: string): void;
}

const NOTES_KEY = 'agent:notes';

function readNotes(store: NoteStore, sessionId: string): Record<string, string> {
  const raw = store.get(sessionId, NOTES_KEY);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeNotes(store: NoteStore, sessionId: string, notes: Record<string, string>): void {
  store.set(sessionId, NOTES_KEY, JSON.stringify(notes));
}

/** Render saved notes as injectable system context, or undefined when there are none. */
export function renderNotes(store: NoteStore, sessionId: string): string | undefined {
  const notes = readNotes(store, sessionId);
  const keys = Object.keys(notes);
  if (keys.length === 0) return undefined;
  return `Notes you saved earlier this session:\n${keys.map((k) => `- ${k}: ${notes[k]}`).join('\n')}`;
}

interface RememberInput {
  key: string;
  value: string;
}

const rememberInput: ToolInputSchema<RememberInput> = {
  safeParse: (input) => {
    const o = (input ?? {}) as Record<string, unknown>;
    if (typeof o.key !== 'string' || o.key.length === 0) {
      return { success: false, error: new Error('memory_remember requires a non-empty "key"') };
    }
    if (typeof o.value !== 'string') {
      return { success: false, error: new Error('memory_remember requires a string "value"') };
    }
    return { success: true, data: { key: o.key, value: o.value } };
  },
  toJsonSchema: () => ({
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Short label for the fact (e.g. "deploy_target")' },
      value: { type: 'string', description: 'The fact to remember for the rest of this session' }
    },
    required: ['key', 'value']
  })
};

const keyInput: ToolInputSchema<{ key: string }> = {
  safeParse: (input) => {
    const key = (input as { key?: unknown })?.key;
    return typeof key === 'string' && key.length > 0
      ? { success: true, data: { key } }
      : { success: false, error: new Error('a non-empty "key" is required') };
  },
  toJsonSchema: () => ({
    type: 'object',
    properties: { key: { type: 'string', description: 'The note key' } },
    required: ['key']
  })
};

/** Build the memory_* tools over a session-scoped note backend. */
export function createMemoryTools(store: NoteStore): Tool[] {
  const remember: Tool<RememberInput, { ok: true }> = {
    name: 'memory_remember',
    description:
      'Save a fact for the rest of this session. Saved notes are automatically re-surfaced at the start of every later turn, so you do not need to repeat them. Re-using a key overwrites it.',
    scopes: [{ resource: 'memory:write' }],
    inputSchema: rememberInput,
    inputExamples: [{ key: 'deploy_target', value: 'staging cluster eu-west-1' }],
    run: async (input, ctx: ToolContext) => {
      const notes = readNotes(store, ctx.sessionId);
      notes[input.key] = input.value;
      writeNotes(store, ctx.sessionId, notes);
      return toolResult({ ok: true });
    }
  };

  const recall: Tool<{ key: string }, { value: string | null }> = {
    name: 'memory_recall',
    description: 'Recall a single saved note by key (returns null if unset). Notes also auto-inject each turn.',
    scopes: [{ resource: 'memory:read' }],
    inputSchema: keyInput,
    run: async (input, ctx: ToolContext) => toolResult({ value: readNotes(store, ctx.sessionId)[input.key] ?? null })
  };

  const forget: Tool<{ key: string }, { ok: true }> = {
    name: 'memory_forget',
    description: 'Delete a saved note by key.',
    scopes: [{ resource: 'memory:write' }],
    inputSchema: keyInput,
    run: async (input, ctx: ToolContext) => {
      const notes = readNotes(store, ctx.sessionId);
      delete notes[input.key];
      writeNotes(store, ctx.sessionId, notes);
      return toolResult({ ok: true });
    }
  };

  return [remember, recall, forget];
}

// Uniform module entry. memory is a service module — it needs a note backend; absent → no tools.
export const register: ToolModule = ({ notes }) => (notes ? createMemoryTools(notes) : []);
