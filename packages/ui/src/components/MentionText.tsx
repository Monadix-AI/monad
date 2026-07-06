import { cn } from '../lib/utils.ts';

export interface MentionToken {
  name: string;
  id: string;
  start: number;
  end: number;
}

export type MentionSegment = { kind: 'text'; text: string } | { kind: 'mention'; name: string; id: string };

const MENTION_TOKEN_RE = /@\[name="((?:\\.|[^"\\])*)"\s+id="((?:\\.|[^"\\])*)"\]/g;

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

export function MentionCapsule({ id, name }: { id: string; name: string }) {
  return (
    <span
      className="inline-flex items-baseline gap-[0.14em] align-baseline text-accent-blue leading-[inherit]"
      title={id}
    >
      <span
        aria-hidden="true"
        className="inline-block size-[0.94em] shrink-0 translate-y-[0.14em] bg-current"
        style={{
          WebkitMaskImage: 'url("/monad-icon-vector-solid.svg")',
          WebkitMaskPosition: 'center',
          WebkitMaskRepeat: 'no-repeat',
          WebkitMaskSize: 'contain',
          maskImage: 'url("/monad-icon-vector-solid.svg")',
          maskPosition: 'center',
          maskRepeat: 'no-repeat',
          maskSize: 'contain'
        }}
      />
      {name}
    </span>
  );
}

export function MentionText({ text, className }: { text: string; className?: string }) {
  let offset = 0;
  return (
    <span className={cn('whitespace-pre-wrap break-words [overflow-wrap:anywhere]', className)}>
      {mentionSegments(text).map((segment) => {
        const key = `${segment.kind}:${offset}`;
        offset += segment.kind === 'mention' ? mentionToken(segment).length : segment.text.length;
        return segment.kind === 'mention' ? (
          <MentionCapsule
            id={segment.id}
            key={key}
            name={segment.name}
          />
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
