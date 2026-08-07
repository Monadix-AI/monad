const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"'
};

function decodedEntity(entity: string): string | undefined {
  const normalized = entity.toLowerCase();
  const named = NAMED_ENTITIES[normalized];
  if (named !== undefined) return named;

  const radix = normalized.startsWith('#x') ? 16 : 10;
  const digits = normalized.startsWith('#x')
    ? normalized.slice(2)
    : normalized.startsWith('#')
      ? normalized.slice(1)
      : '';
  if (!digits) return undefined;
  const codePoint = Number.parseInt(digits, radix);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return undefined;
  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntitiesOnce(value: string): string {
  let decoded = '';
  for (let cursor = 0; cursor < value.length; cursor++) {
    if (value[cursor] !== '&') {
      decoded += value[cursor];
      continue;
    }
    const end = value.indexOf(';', cursor + 1);
    if (end === -1 || end - cursor > 12) {
      decoded += '&';
      continue;
    }
    const entity = decodedEntity(value.slice(cursor + 1, end));
    if (entity === undefined) {
      decoded += '&';
      continue;
    }
    decoded += entity;
    cursor = end;
  }
  return decoded;
}

function tagEnd(value: string, start: number): number {
  let cursor = start + 1;
  if (value[cursor] === '/') cursor++;
  const opener = value[cursor];
  if (!opener || !(opener === '!' || opener === '?' || /[a-z]/i.test(opener))) return -1;

  let quote: '"' | "'" | undefined;
  for (; cursor < value.length; cursor++) {
    const character = value[cursor];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return cursor;
  }
  return -1;
}

export function stripHtmlMarkup(value: string, replacement = ''): string {
  let text = '';
  for (let cursor = 0; cursor < value.length; cursor++) {
    if (value[cursor] === '<') {
      const end = tagEnd(value, cursor);
      if (end !== -1) {
        text += replacement;
        cursor = end;
        continue;
      }
    }
    text += value[cursor];
  }
  return text;
}

export function htmlToPlainText(value: string, tagReplacement = ''): string {
  const withoutMarkup = stripHtmlMarkup(value, tagReplacement);
  return stripHtmlMarkup(decodeHtmlEntitiesOnce(withoutMarkup), tagReplacement);
}
