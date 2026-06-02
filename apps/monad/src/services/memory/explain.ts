// "Why do you believe X" — match a free-text query against the stored L3 laws, lexically. Laws are
// few per scope, so a token-overlap score is enough; the daemon then resolves each match's grounding
// (facts + relations) and traces the relations to their source messages (the bottom of the chain).

const tokenize = (s: string): Set<string> => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** The laws whose statement shares the most words with the query, most-overlapping first (top `limit`). */
export function matchLaws<T extends { statement: string }>(laws: T[], query: string, limit = 3): T[] {
  const q = tokenize(query);
  if (q.size === 0) return [];
  return laws
    .map((law) => ({ law, score: [...tokenize(law.statement)].filter((t) => q.has(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.law);
}
