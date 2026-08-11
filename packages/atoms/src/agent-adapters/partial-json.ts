import { Allow, parse as parsePartialJson } from 'partial-json';

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
