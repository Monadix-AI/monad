export interface NativeCliArgumentSupport {
  flags: string[];
  reasoningEfforts: string[];
  speeds: string[];
}

const REASONING_FLAGS = new Set(['--effort', '--reasoning-effort', '--model-reasoning-effort']);
const SPEED_FLAGS = new Set(['--speed', '--service-tier']);
const VALUE_PLACEHOLDERS = new Set(['level', 'value', 'values', 'format', 'model', 'path', 'file', 'dir', 'prompt']);

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseValueList(text: string): string[] {
  return unique(
    text
      .split(/[,|]/)
      .map((value) => value.replace(/[.'"`()[\]{}]/g, '').trim())
      .filter((value) => /^[a-z][a-z0-9_-]*$/i.test(value))
      .filter((value) => !VALUE_PLACEHOLDERS.has(value.toLowerCase()))
  );
}

function valuesFromFlagWindow(window: string): string[] {
  const values: string[] = [];
  const angle = window.match(/<([^>]+)>/);
  if (angle?.[1]) values.push(...parseValueList(angle[1]));
  const bracket = window.match(/\[([a-z0-9_,| -]+)\]/i);
  if (bracket?.[1]) values.push(...parseValueList(bracket[1]));
  const paren = window.match(/\(([a-z0-9_,| -]+)\)/i);
  if (paren?.[1]) values.push(...parseValueList(paren[1]));
  const valid = window.match(/(?:valid|possible|allowed) values?:\s*([^.;\n]+)/i);
  if (valid?.[1]) values.push(...parseValueList(valid[1]));
  const oneOf = window.match(/(?:one of|choices?):\s*([^.;\n]+)/i);
  if (oneOf?.[1]) values.push(...parseValueList(oneOf[1]));
  return values;
}

function valuesNearFlag(output: string, flag: string): string[] {
  const lines = output.split(/\r?\n/);
  const values: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.includes(flag)) continue;
    const sameLineValues = valuesFromFlagWindow(line);
    values.push(
      ...(sameLineValues.length > 0 ? sameLineValues : valuesFromFlagWindow([line, lines[index + 1] ?? ''].join(' ')))
    );
  }
  return unique(values);
}

export function parseNativeCliArgumentSupport(output: string): NativeCliArgumentSupport {
  const flags = unique([...output.matchAll(/(^|[\s,])(--[a-z0-9][a-z0-9-]*)/gi)].map((match) => match[2] ?? ''));
  return {
    flags,
    reasoningEfforts: unique([...REASONING_FLAGS].flatMap((flag) => valuesNearFlag(output, flag))),
    speeds: unique([...SPEED_FLAGS].flatMap((flag) => valuesNearFlag(output, flag)))
  };
}
