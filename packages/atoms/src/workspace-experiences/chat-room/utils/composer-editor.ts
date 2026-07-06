export function activeMention(value: string, caret: number): { query: string; start: number } | null {
  const before = value.slice(0, caret);
  const m = before.match(/(?:^|\s)@([\w.-]*)$/);
  if (!m) return null;
  const query = m[1] ?? '';
  return { query, start: caret - query.length - 1 };
}
