/** Unwrap an Eden Treaty result, throwing on a null body (i.e. a non-2xx response). */
export function requireTreatyData<T>(result: { data: T | null; status: number }): T {
  if (result.data === null) throw new Error(`request failed: ${result.status}`);
  return result.data;
}
