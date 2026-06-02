import type { JSONContent } from '@tiptap/core';

import { mentionToken, parseMentionTokens } from './MentionText';

export type ComposerSkillToken = {
  icon?: string;
  id: string;
  label: string;
  onClick?: () => void;
  raw: string;
  source?: string;
  version?: string;
};

export type ComposerCommandToken = {
  label: string;
  raw: string;
};

const SKILL_ID_RE =
  /\/((?:global:[a-z0-9-]+)|(?:atom-pack:[a-z0-9-]+:[a-z0-9-]+)|(?:agent:[a-z0-9-]+:[a-z0-9-]+))(?=\s|$)/g;

export function serializedTextToTiptapDoc(
  text: string,
  skillToken?: ComposerSkillToken,
  commandToken?: ComposerCommandToken
): JSONContent {
  const lines = text.split('\n');
  const content: JSONContent[] = [];
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex] ?? '';
    const orderedItem = parseOrderedListLine(line);
    if (!orderedItem) {
      content.push({
        type: 'paragraph',
        content: serializedLineToContent(line, skillToken, commandToken)
      });
      lineIndex += 1;
      continue;
    }
    const items: JSONContent[] = [];
    const start = orderedItem.number;
    while (lineIndex < lines.length) {
      const item = parseOrderedListLine(lines[lineIndex] ?? '');
      if (!item) break;
      lineIndex += 1;
      const itemLines = [item.text];
      while (lineIndex < lines.length) {
        const continuation = /^ {3}(.*)$/.exec(lines[lineIndex] ?? '');
        if (!continuation) break;
        itemLines.push(continuation[1] ?? '');
        lineIndex += 1;
      }
      items.push({
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: serializedMultilineToContent(itemLines, skillToken, commandToken)
          }
        ]
      });
    }
    content.push({
      type: 'orderedList',
      attrs: { start },
      content: items
    });
  }
  return {
    type: 'doc',
    content
  };
}

export function tiptapDocToSerializedText(doc: JSONContent): string {
  return (doc.content ?? []).map(tiptapBlockToSerializedText).join('\n');
}

function parseOrderedListLine(line: string): { number: number; text: string } | null {
  const match = /^(\d+)\.\s(.*)$/.exec(line);
  if (!match) return null;
  return {
    number: Number(match[1]),
    text: match[2] ?? ''
  };
}

function serializedLineToContent(
  text: string,
  skillToken?: ComposerSkillToken,
  commandToken?: ComposerCommandToken
): JSONContent[] {
  const content: JSONContent[] = [];
  let cursor = 0;
  const spans = [
    ...parseMentionTokens(text).map((token) => ({
      kind: 'mention' as const,
      start: token.start,
      end: token.end,
      token
    })),
    ...parseSkillTokens(text, skillToken).map((token) => ({
      kind: 'skill' as const,
      start: token.start,
      end: token.end,
      token
    })),
    ...parseCommandTokens(text, commandToken).map((token) => ({
      kind: 'command' as const,
      start: token.start,
      end: token.end,
      token
    }))
  ].sort((a, b) => a.start - b.start);

  for (const span of spans) {
    if (span.start < cursor) continue;
    if (span.start > cursor) content.push({ type: 'text', text: text.slice(cursor, span.start) });
    if (span.kind === 'mention') {
      content.push({ type: 'mention', attrs: { id: span.token.id, label: span.token.name } });
    } else if (span.kind === 'skill') {
      content.push({ type: 'composerSkillToken', attrs: span.token.payload });
    } else {
      content.push({ type: 'composerCommandToken', attrs: span.token.payload });
    }
    cursor = span.end;
  }
  if (cursor < text.length) content.push({ type: 'text', text: text.slice(cursor) });
  return content;
}

function serializedMultilineToContent(
  lines: string[],
  skillToken?: ComposerSkillToken,
  commandToken?: ComposerCommandToken
): JSONContent[] {
  return lines.flatMap((line, index) => [
    ...(index > 0 ? [{ type: 'hardBreak' }] : []),
    ...serializedLineToContent(line, skillToken, commandToken)
  ]);
}

function parseSkillTokens(
  text: string,
  skillToken?: ComposerSkillToken
): { end: number; payload: ComposerSkillToken; start: number }[] {
  return [...text.matchAll(SKILL_ID_RE)].map((match) => {
    const start = match.index ?? 0;
    const id = match[1] as string;
    const raw = `/${id}`;
    return {
      start,
      end: start + raw.length,
      payload:
        skillToken?.raw === raw
          ? skillToken
          : {
              id,
              label: fallbackSkillLabel(id),
              raw,
              source: fallbackSkillSource(id)
            }
    };
  });
}

function parseCommandTokens(
  text: string,
  commandToken?: ComposerCommandToken
): { end: number; payload: ComposerCommandToken; start: number }[] {
  if (!commandToken?.raw) return [];
  const leading = /^\s*/.exec(text)?.[0].length ?? 0;
  if (!text.startsWith(commandToken.raw, leading)) return [];
  const end = leading + commandToken.raw.length;
  const next = text[end];
  if (next && !/\s/.test(next)) return [];
  return [{ start: leading, end, payload: commandToken }];
}

function tiptapBlockToSerializedText(block: JSONContent): string {
  if (block.type === 'orderedList') {
    const start = typeof block.attrs?.start === 'number' ? block.attrs.start : 1;
    return (block.content ?? [])
      .map((item, index) => formatOrderedListItem(start + index, tiptapListItemToSerializedText(item)))
      .join('\n');
  }
  return (block.content ?? []).map(tiptapNodeToSerializedText).join('');
}

function tiptapListItemToSerializedText(item: JSONContent): string {
  return (item.content ?? []).map(tiptapBlockToSerializedText).join('\n');
}

function formatOrderedListItem(number: number, text: string): string {
  const [firstLine = '', ...continuationLines] = text.split('\n');
  return [`${number}. ${firstLine}`, ...continuationLines.map((line) => `   ${line}`)].join('\n');
}

function tiptapNodeToSerializedText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'mention') {
    return mentionToken({ id: String(node.attrs?.id ?? ''), name: String(node.attrs?.label ?? '') });
  }
  if (node.type === 'composerSkillToken') return String(node.attrs?.raw ?? '');
  if (node.type === 'composerCommandToken') return String(node.attrs?.raw ?? '');
  if (node.type === 'hardBreak') return '\n';
  return (node.content ?? []).map(tiptapNodeToSerializedText).join('');
}

function fallbackSkillLabel(id: string): string {
  const parts = id.split(':');
  if (parts.length === 2 && parts[0] === 'global') return parts[1] ?? id;
  if (parts.length === 3 && (parts[0] === 'atom-pack' || parts[0] === 'agent')) return parts[2] ?? id;
  return id;
}

function fallbackSkillSource(id: string): string | undefined {
  const parts = id.split(':');
  if (parts.length === 2 && parts[0] === 'global') return 'Global';
  if (parts.length === 3 && parts[0] === 'atom-pack') return `Atom Pack: ${parts[1]}`;
  if (parts.length === 3 && parts[0] === 'agent') return `Agent: ${parts[1]}`;
  return undefined;
}
