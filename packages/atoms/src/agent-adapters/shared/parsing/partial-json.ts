import { Allow, parse as parsePartialJson } from 'partial-json';

/** Parse incomplete structured arguments emitted by streaming provider protocols. */
export function parseStreamingJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    try {
      return parsePartialJson(value, Allow.STR | Allow.OBJ | Allow.ARR) as unknown;
    } catch {
      return value;
    }
  }
}
