import type { CommandItem } from '@monad/protocol';

export type FuzzyMatch = { indices: number[]; rank: number };

function fuzzyMatch(candidate: string, query: string): FuzzyMatch | null {
  if (!query) return { indices: [], rank: 0 };
  const source = candidate.toLowerCase();
  const needle = query.toLowerCase();
  const indices: number[] = [];
  let cursor = 0;
  for (const char of needle) {
    const index = source.indexOf(char, cursor);
    if (index === -1) return null;
    indices.push(index);
    cursor = index + 1;
  }
  const contiguous = source.includes(needle);
  const prefix = source.startsWith(needle);
  const firstIndex = indices[0] ?? 0;
  const lastIndex = indices.at(-1) ?? firstIndex;
  const spread = lastIndex - firstIndex;
  return {
    indices,
    rank: (prefix ? 0 : contiguous ? 1 : 2) * 1000 + spread
  };
}

export function bestCommandMatch(
  command: CommandItem,
  query: string
): (FuzzyMatch & { labelIndices: number[] }) | null {
  const nameMatch = fuzzyMatch(command.name, query);
  const idMatch = fuzzyMatch(command.id, query);
  if (!nameMatch && !idMatch) return null;
  if (nameMatch && (!idMatch || nameMatch.rank <= idMatch.rank)) {
    return { ...nameMatch, labelIndices: nameMatch.indices };
  }
  if (!idMatch) return null;
  return { ...idMatch, labelIndices: [] };
}

export function bestLabelMatch(label: string, query: string): FuzzyMatch | null {
  return fuzzyMatch(label, query);
}
