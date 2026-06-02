// Assembles the read-only "mem0 explorer" view: every stored memory (per scope), a 2D projection of
// their embeddings for the cluster map, per-scope counts, and the vector-store status. All external
// bits (entry listing, vector fetch, status) are injected so it's testable without mem0/qdrant.

import type { Logger } from '@monad/logger';

import { project2d } from './pca2d.ts';

export interface Mem0Data {
  available: boolean; // mem0 is the active backend (and reachable)
  vectorStore: string; // 'qdrant' | 'memory' | …
  qdrant: { phase: string; error: string | null } | null;
  total: number;
  scopeCounts: { scope: string; count: number }[];
  entries: { id: string; scope: string; text: string; x: number | null; y: number | null }[];
}

export interface Mem0ExplorerDeps {
  available: () => boolean;
  vectorStoreName: () => string;
  scopes: () => { scope: string; kind: 'global' | 'agent'; id: string }[];
  /** mem0 entries for one scope (routes through the adapter's getAll). */
  listEntries: (kind: 'global' | 'agent', id: string) => Promise<{ id: string; text: string }[]>;
  /** id → embedding, from the vector store (qdrant scroll). Optional/best-effort: the cluster map
   *  degrades gracefully when absent or it throws. */
  fetchVectors?: () => Promise<Map<string, number[]>>;
  qdrantStatus?: () => { phase: string; error: string | null } | null;
  log: Logger;
}

/** Scroll a qdrant collection for point id → embedding (for the cluster projection). Best-effort: any
 *  failure throws and the caller degrades. Point ids are coerced to string to match mem0's memory ids. */
export async function fetchQdrantVectors(url: string, collection: string): Promise<Map<string, number[]>> {
  const res = await fetch(`${url}/collections/${collection}/points/scroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit: 2000, with_vector: true, with_payload: false }),
    signal: AbortSignal.timeout(3000)
  });
  if (!res.ok) throw new Error(`qdrant scroll ${res.status}`);
  const body = (await res.json()) as { result?: { points?: { id: string | number; vector?: number[] }[] } };
  const out = new Map<string, number[]>();
  for (const p of body.result?.points ?? []) if (Array.isArray(p.vector)) out.set(String(p.id), p.vector);
  return out;
}

export async function collectMem0Data(deps: Mem0ExplorerDeps): Promise<Mem0Data> {
  const base = {
    vectorStore: deps.vectorStoreName(),
    qdrant: deps.qdrantStatus?.() ?? null
  };
  if (!deps.available()) {
    return { available: false, ...base, total: 0, scopeCounts: [], entries: [] };
  }

  const raw: { id: string; scope: string; text: string }[] = [];
  for (const s of deps.scopes()) {
    try {
      for (const e of await deps.listEntries(s.kind, s.id)) raw.push({ id: e.id, scope: s.scope, text: e.text });
    } catch (err) {
      deps.log.warn(`mem0-explorer: list ${s.scope} failed: ${String(err)}`);
    }
  }

  // Best-effort 2D projection of the embeddings for the cluster map.
  const coords = new Map<string, { x: number; y: number }>();
  if (deps.fetchVectors) {
    try {
      const vecById = await deps.fetchVectors();
      const withVec = raw.filter((r) => vecById.has(r.id));
      const proj = project2d(withVec.map((r) => vecById.get(r.id) as number[]));
      withVec.forEach((r, i) => {
        const p = proj[i];
        if (p) coords.set(r.id, p);
      });
    } catch (err) {
      deps.log.warn(`mem0-explorer: vector projection skipped: ${String(err)}`);
    }
  }

  const counts = new Map<string, number>();
  for (const r of raw) counts.set(r.scope, (counts.get(r.scope) ?? 0) + 1);

  return {
    available: true,
    ...base,
    total: raw.length,
    scopeCounts: [...counts].map(([scope, count]) => ({ scope, count })).sort((a, b) => b.count - a.count),
    entries: raw.map((r) => ({ ...r, x: coords.get(r.id)?.x ?? null, y: coords.get(r.id)?.y ?? null }))
  };
}
