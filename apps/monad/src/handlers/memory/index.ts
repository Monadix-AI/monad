// Control-API module for L1 memory — thin wire adapter over the daemon MemoryService facade.
// Backs transports/http/memory and the web Memory settings UI.

import type {
  AddMemoryFactRequest,
  EditMemoryFactRequest,
  ForgetMemoryFactRequest,
  ListMemoryFactsQuery,
  ListMemoryFactsResponse,
  MemoryBackendId,
  MemoryCoreResponse,
  MemoryFactResponse,
  MemoryScopeQuery,
  MemoryStatusResponse,
  OkResponse,
  PutMemoryCoreRequest,
  SetMem0ModelsRequest,
  SetMemoryBackendRequest,
  SetMemoryGraphRequest
} from '@monad/protocol';
import type { MemoryService } from '@/services/memory/index.ts';

import { HandlerError } from '@/handlers/handler-error.ts';

export function createMemoryModule(
  svc: MemoryService,
  setBackend: (b: MemoryBackendId) => Promise<void>,
  setMem0Models: (sel: SetMem0ModelsRequest) => Promise<void>,
  setGraph: (sel: SetMemoryGraphRequest) => Promise<void>
) {
  return {
    async status(): Promise<MemoryStatusResponse> {
      return svc.status();
    },
    async setBackend(req: SetMemoryBackendRequest): Promise<OkResponse> {
      await setBackend(req.backend);
      return { ok: true };
    },
    async setMem0Models(req: SetMem0ModelsRequest): Promise<OkResponse> {
      await setMem0Models(req);
      return { ok: true };
    },
    async setGraph(req: SetMemoryGraphRequest): Promise<OkResponse> {
      await setGraph(req);
      return { ok: true };
    },
    async listFacts(q: ListMemoryFactsQuery): Promise<ListMemoryFactsResponse> {
      const all = await svc.listFacts(q.scopeKind, q.scopeId);
      // Stable, deterministic order so `before` cursors are consistent across calls.
      const sorted = [...all].sort((a, b) => a.id.localeCompare(b.id));
      const startIdx = q.before ? sorted.findIndex((f) => f.id === q.before) : -1;
      const rest = startIdx >= 0 ? sorted.slice(startIdx + 1) : sorted;
      const limit = q.limit ?? rest.length;
      const page = rest.slice(0, limit);
      const nextCursor = rest.length > limit ? page[page.length - 1]?.id : undefined;
      return { facts: page, nextCursor };
    },
    async getCore(q: MemoryScopeQuery): Promise<MemoryCoreResponse> {
      return {
        scope: { kind: q.scopeKind, id: q.scopeKind === 'global' ? '*' : q.scopeId },
        core: await svc.getCore(q.scopeKind, q.scopeId)
      };
    },
    async putCore(req: PutMemoryCoreRequest): Promise<OkResponse> {
      await svc.putCore(req.scopeKind, req.scopeId, req.core);
      return { ok: true };
    },
    async addFact(req: AddMemoryFactRequest): Promise<MemoryFactResponse> {
      const fact = await svc.addFact(req.scopeKind, req.scopeId, req.content);
      if (!fact) throw new HandlerError('invalid', 'fact rejected (empty, secret-only, or injection-shaped)');
      return { fact };
    },
    async editFact(req: EditMemoryFactRequest): Promise<MemoryFactResponse> {
      const fact = await svc.editFact(req.scopeKind, req.scopeId, req.id, req.content);
      if (!fact) throw new HandlerError('not_found', `fact not found or not editable on this backend: ${req.id}`);
      return { fact };
    },
    async forgetFact(req: ForgetMemoryFactRequest): Promise<OkResponse> {
      const removed = await svc.forgetFact(req.scopeKind, req.scopeId, req.id);
      if (!removed) throw new HandlerError('not_found', `fact not found: ${req.id}`);
      return { ok: true };
    }
  };
}
