import type { SearchHit, SearchMode, SearchSessionsResponse, TranscriptTargetId } from '@monad/protocol';
import type { SessionContext } from '@/handlers/session/context.ts';

function rrfMerge(keyword: SearchHit[], semantic: SearchHit[], limit: number): SearchHit[] {
  const K0 = 60;
  const acc = new Map<string, { hit: SearchHit; score: number; inK: boolean; inS: boolean }>();
  for (const [i, h] of keyword.entries()) {
    acc.set(h.messageId, { hit: h, score: 1 / (K0 + i + 1), inK: true, inS: false });
  }
  semantic.forEach((h, i) => {
    const cur = acc.get(h.messageId);
    if (cur) {
      cur.score += 1 / (K0 + i + 1);
      cur.inS = true;
    } else {
      acc.set(h.messageId, { hit: h, score: 1 / (K0 + i + 1), inK: false, inS: true });
    }
  });
  return [...acc.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ hit, score, inK, inS }) => ({
      ...hit,
      score,
      matchedBy: inK && inS ? 'both' : inK ? 'keyword' : 'semantic'
    }));
}

export function createSearchHandlers(ctx: SessionContext) {
  const {
    deps: { store, agent }
  } = ctx;

  return {
    async search({
      q,
      mode = 'hybrid',
      limit,
      transcriptTargetId
    }: {
      q: string;
      mode?: SearchMode;
      limit?: number;
      transcriptTargetId?: TranscriptTargetId;
    }): Promise<SearchSessionsResponse> {
      const keywordOnly = (): SearchSessionsResponse => ({
        hits: store.searchMessages({ q, mode: 'keyword', limit, transcriptTargetId })
      });
      const embed = agent.model.embed?.bind(agent.model);
      if ((mode !== 'semantic' && mode !== 'hybrid') || !embed) return keywordOnly();

      const k = limit ?? 20;
      try {
        // Only the query is embedded on the request path (one call). Message vectors are produced
        // off-path by the background indexer, so semantic search runs over whatever is already
        // indexed — recall may lag indexing, which the client surfaces as an "indexing" hint.
        const {
          embeddings: [qVec]
        } = await embed([q]);
        if (!qVec) return keywordOnly();

        const indexingPending = store.pendingEmbeddingCount(transcriptTargetId);
        const semantic = store.searchSemantic(qVec, { limit: k * 2, transcriptTargetId });
        if (mode === 'semantic') return { hits: semantic.slice(0, k), indexingPending };

        const keyword = store.searchMessages({ q, mode: 'keyword', limit: k * 2, transcriptTargetId });
        return { hits: rrfMerge(keyword, semantic, k), indexingPending };
      } catch {
        // No embedding model / provider failure — semantic search is best-effort, never fatal.
        return keywordOnly();
      }
    }
  };
}
