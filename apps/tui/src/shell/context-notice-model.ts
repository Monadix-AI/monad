import type { TuiMemorySuggestion } from './stream-model.ts';

export function activeMemorySuggestion(
  suggestion: TuiMemorySuggestion | undefined,
  handledId: string | null
): TuiMemorySuggestion | undefined {
  return suggestion && suggestion.id !== handledId ? suggestion : undefined;
}
