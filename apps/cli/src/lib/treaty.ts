/** Unwrap an Eden Treaty result, throwing on a null body (i.e. a non-2xx response). */
export function requireTreatyData<T>(result: { data: T | Response | null; status: number }): Exclude<T, Response> {
  if (result.data === null) throw new Error(`request failed: ${result.status}`);
  if (result.data instanceof Response) throw new Error('request returned a raw Response instead of JSON data');
  return result.data as Exclude<T, Response>;
}
