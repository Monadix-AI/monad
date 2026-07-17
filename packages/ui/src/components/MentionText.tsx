import { cn } from '../lib/utils.ts';
import { ComposerInlineChip } from './ComposerInlineChip';
import { FaviconLink, faviconHref } from './FaviconLink';

export interface MentionToken {
  name: string;
  id: string;
  start: number;
  end: number;
}

export type MentionSegment = { kind: 'text'; text: string } | { kind: 'mention'; name: string; id: string };
export type MessageTextSegment = MentionSegment | { kind: 'url'; href: string; text: string };

const MENTION_TOKEN_RE = /@\[name="((?:\\.|[^"\\])*)"\s+id="((?:\\.|[^"\\])*)"\]/g;
const WEB_URL_RE = /https?:\/\/[^\s<]+/gi;
const TRAILING_URL_PUNCTUATION_RE = /[.,!?;:]+$/;

function unescapeMentionValue(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}

function escapeMentionValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function mentionToken({ name, id }: { name: string; id: string }): string {
  return `@[name="${escapeMentionValue(name)}" id="${escapeMentionValue(id)}"]`;
}

export function parseMentionTokens(text: string): MentionToken[] {
  return [...text.matchAll(MENTION_TOKEN_RE)].map((match) => ({
    name: unescapeMentionValue(match[1] ?? ''),
    id: unescapeMentionValue(match[2] ?? ''),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length
  }));
}

export function mentionSegments(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const token of parseMentionTokens(text)) {
    if (token.start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, token.start) });
    segments.push({ kind: 'mention', name: token.name, id: token.id });
    cursor = token.end;
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
  return segments;
}

function pushTextSegment(segments: MessageTextSegment[], text: string): void {
  if (!text) return;
  const previous = segments.at(-1);
  if (previous?.kind === 'text') previous.text += text;
  else segments.push({ kind: 'text', text });
}

function linkifiedTextSegments(text: string): MessageTextSegment[] {
  const segments: MessageTextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(WEB_URL_RE)) {
    const start = match.index ?? 0;
    const matched = match[0];
    const punctuation = TRAILING_URL_PUNCTUATION_RE.exec(matched)?.[0] ?? '';
    const href = punctuation ? matched.slice(0, -punctuation.length) : matched;
    if (start > cursor) pushTextSegment(segments, text.slice(cursor, start));
    if (faviconHref(href)) segments.push({ kind: 'url', href, text: href });
    else pushTextSegment(segments, href);
    pushTextSegment(segments, punctuation);
    cursor = start + matched.length;
  }
  if (cursor < text.length) pushTextSegment(segments, text.slice(cursor));
  return segments;
}

export function messageTextSegments(text: string): MessageTextSegment[] {
  return mentionSegments(text).flatMap((segment) =>
    segment.kind === 'mention' ? [segment] : linkifiedTextSegments(segment.text)
  );
}

export function MentionCapsule({ id, name }: { id: string; name: string }) {
  return (
    <ComposerInlineChip
      kind="mention"
      label={name}
      title={id}
    />
  );
}

export function MentionText({ text, className }: { text: string; className?: string }) {
  let offset = 0;
  return (
    <span className={cn('whitespace-pre-wrap break-words [overflow-wrap:anywhere]', className)}>
      {messageTextSegments(text).map((segment) => {
        const key = `${segment.kind}:${offset}`;
        offset += segment.kind === 'mention' ? mentionToken(segment).length : segment.text.length;
        return segment.kind === 'mention' ? (
          <MentionCapsule
            id={segment.id}
            key={key}
            name={segment.name}
          />
        ) : segment.kind === 'url' ? (
          <FaviconLink
            href={segment.href}
            key={key}
          >
            {segment.text}
          </FaviconLink>
        ) : (
          <span
            className="[overflow-wrap:anywhere]"
            key={key}
          >
            {segment.text}
          </span>
        );
      })}
    </span>
  );
}
