/** Drop keys whose value is `undefined` so an optional argument that was simply not supplied does not
 *  overwrite a factory default when the input is spread over it. */
export function definedOnly<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}
