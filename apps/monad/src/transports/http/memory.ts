import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import {
  addMemoryFactRequestSchema,
  editMemoryFactRequestSchema,
  forgetMemoryFactRequestSchema,
  listMemoryFactsResponseSchema,
  memoryCoreResponseSchema,
  memoryFactResponseSchema,
  memoryScopeQuerySchema,
  memoryStatusResponseSchema,
  okResponseSchema,
  putMemoryCoreRequestSchema,
  setMem0ModelsRequestSchema,
  setMemoryBackendRequestSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';

// L1 memory control API (§11.2 slice): list/add/edit/forget facts + read/overwrite a scope's
// MEMORY.md. Scope is (scopeKind, scopeId) — 'global' uses any id ('*' canonically).
export function createMemoryController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] })
    .get('/memory/status', async () => handlers.memory.status(), {
      response: { 200: memoryStatusResponseSchema },
      detail: { summary: 'Active memory backend', description: 'Selected L1 backend + mem0 model resolution.' }
    })
    .put('/memory/backend', async ({ body }) => handlers.memory.setBackend(setMemoryBackendRequestSchema.parse(body)), {
      body: setMemoryBackendRequestSchema,
      response: { 200: okResponseSchema },
      detail: { summary: 'Switch memory backend', description: 'builtin (local MD) or mem0 (cloud extraction).' }
    })
    .put(
      '/memory/mem0/models',
      async ({ body }) => handlers.memory.setMem0Models(setMem0ModelsRequestSchema.parse(body)),
      {
        body: setMem0ModelsRequestSchema,
        response: { 200: okResponseSchema },
        detail: {
          summary: 'Set mem0 models',
          description: "mem0's LLM + embedder, chosen from Monad's model registry."
        }
      }
    )
    .get('/memory/facts', async ({ query }) => handlers.memory.listFacts(memoryScopeQuerySchema.parse(query)), {
      query: memoryScopeQuerySchema,
      response: { 200: listMemoryFactsResponseSchema },
      detail: { summary: 'List memory facts', description: 'Facts recorded for a scope (global/agent/session).' }
    })
    .get('/memory/core', async ({ query }) => handlers.memory.getCore(memoryScopeQuerySchema.parse(query)), {
      query: memoryScopeQuerySchema,
      response: { 200: memoryCoreResponseSchema },
      detail: { summary: 'Read scope MEMORY.md', description: 'Raw markdown for a scope (source of truth).' }
    })
    .put('/memory/core', async ({ body }) => handlers.memory.putCore(putMemoryCoreRequestSchema.parse(body)), {
      body: putMemoryCoreRequestSchema,
      response: { 200: okResponseSchema },
      detail: { summary: 'Overwrite scope MEMORY.md', description: 'Replace a scope memory file verbatim.' }
    })
    .post('/memory/facts', async ({ body }) => handlers.memory.addFact(addMemoryFactRequestSchema.parse(body)), {
      body: addMemoryFactRequestSchema,
      response: { 200: memoryFactResponseSchema },
      detail: { summary: 'Add a memory fact', description: 'User-entered fact (sanitized before disk).' }
    })
    .patch('/memory/facts', async ({ body }) => handlers.memory.editFact(editMemoryFactRequestSchema.parse(body)), {
      body: editMemoryFactRequestSchema,
      response: { 200: memoryFactResponseSchema },
      detail: { summary: 'Edit a memory fact', description: 'Replace a fact by id.' }
    })
    .delete(
      '/memory/facts',
      async ({ body }) => handlers.memory.forgetFact(forgetMemoryFactRequestSchema.parse(body)),
      {
        body: forgetMemoryFactRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Forget a memory fact', description: 'Delete a fact by id.' }
      }
    );
}
