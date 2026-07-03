export function buildClarifyAnswer(selected: string[], other: string, multiple: boolean): string | null {
  const values = [...selected, ...(other.trim() ? [other.trim()] : [])];
  if (values.length === 0) return null;
  return multiple ? JSON.stringify(values) : values.join('\n');
}
