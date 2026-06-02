export function isResolvedEmptyList(state: { isLoading: boolean; itemCount: number }): boolean {
  return !state.isLoading && state.itemCount === 0;
}
