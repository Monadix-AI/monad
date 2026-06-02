import type { Card, ClientRenderCaps } from '@monad/protocol';
import type { ComponentType, ReactNode } from 'react';

import { isHttpUrl, pickRepresentation } from '@monad/protocol';
import { Button, cn } from '@monad/ui';
import { Box } from 'lucide-react';

import { Markdown } from './Markdown';
import { MentionText } from './MentionText';

// Tool calls/results are NOT here — they are paired into inline ToolStepView items upstream in
// chat.tsx's viewMessages and never reach MessageBody. This client owns the `card` renderer;
// everything else degrades to markdown/text via the shared registry.
const WEB_RENDER_CAPS: ClientRenderCaps = {
  richTypes: new Set(['card']),
  markdown: true,
  interactions: new Set(['buttons', 'links'])
};

interface RichRendererProps {
  data: unknown;
  text: string;
}

// Card data is model-produced (prompt-injectable). The protocol schema already rejects non-http(s)
// action URLs, but re-check at the render boundary so a persisted/bypassed `javascript:`/`data:` href
// can never become a clickable XSS sink — React does not block dangerous href schemes on its own.
// Uses the same `isHttpUrl` predicate the protocol schema enforces, so the two can't drift.
function safeHttpHref(url: string | undefined): string | undefined {
  return url && isHttpUrl(url) ? url : undefined;
}

function CardRenderer({ data, text }: RichRendererProps) {
  const card = (data ?? {}) as Card;
  const actions = card.actions ?? [];
  return (
    <div className="flex flex-col gap-2">
      {card.title && <div className="font-semibold text-sm">{card.title}</div>}
      <Markdown text={card.body ?? text} />
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {actions.map((a) => {
            const href = safeHttpHref(a.url);
            return href ? (
              <Button
                asChild
                key={`${a.label}:${href}`}
                size="sm"
                variant="secondary"
              >
                <a
                  href={href}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {a.label}
                </a>
              </Button>
            ) : (
              <Button
                disabled
                key={`${a.label}:${a.url ?? ''}`}
                size="sm"
                variant="secondary"
              >
                {a.label}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** type → rich `data` renderer. Keyed by the message `type` (built-in or `atomPackId:type`). */
const MESSAGE_RENDERERS: Record<string, ComponentType<RichRendererProps>> = {
  card: CardRenderer
};

/** Render a message body, degrading by type against this client's capabilities. `data` + `markdown`
 * representations both render through Markdown (which handles plain text), so non-rich types look
 * exactly as before; only a type with a registered renderer and a satisfied `data` chain renders rich. */
export function MessageBody({
  type,
  text,
  data,
  isUser,
  onSkillPreview
}: {
  type?: string;
  text: string;
  data?: unknown;
  isUser: boolean;
  onSkillPreview?: (id: string) => void;
}) {
  if (isUser)
    return (
      <span className={cn('whitespace-pre-wrap')}>
        <UserMessageText
          onSkillPreview={onSkillPreview}
          text={text}
        />
      </span>
    );
  const rep = pickRepresentation(type ?? 'text', WEB_RENDER_CAPS);
  const Renderer = type ? MESSAGE_RENDERERS[type] : undefined;
  if (rep === 'data' && Renderer)
    return (
      <Renderer
        data={data}
        text={text}
      />
    );
  return <Markdown text={text} />;
}

function skillLabel(id: string): string {
  const parts = id.split(':');
  if (parts.length === 2 && parts[0] === 'global') return parts[1] ?? id;
  if (parts.length === 3 && (parts[0] === 'atom-pack' || parts[0] === 'agent')) return parts[2] ?? id;
  return id;
}

function skillSource(id: string): string | null {
  const parts = id.split(':');
  if (parts.length === 2 && parts[0] === 'global') return 'Global';
  if (parts.length === 3 && parts[0] === 'atom-pack') return `Atom Pack: ${parts[1]}`;
  if (parts.length === 3 && parts[0] === 'agent') return `Agent: ${parts[1]}`;
  return null;
}

function UserMessageText({ text, onSkillPreview }: { text: string; onSkillPreview?: (id: string) => void }) {
  const re = /\/((?:global:[a-z0-9-]+)|(?:atom-pack:[a-z0-9-]+:[a-z0-9-]+)|(?:agent:[a-z0-9-]+:[a-z0-9-]+))(?=\s|$)/g;
  const parts: ReactNode[] = [];
  let last = 0;
  const pushText = (value: string, key: string): void => {
    if (!value) return;
    parts.push(
      <MentionText
        key={key}
        text={value}
      />
    );
  };
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    const id = match[1] as string;
    if (start > last) pushText(text.slice(last, start), `text:${last}`);
    parts.push(
      <button
        className="inline-flex max-w-full translate-y-[2px] items-center gap-1.5 rounded-(--radius-md) border border-primary/20 bg-background/80 px-2 py-0.5 text-accent-foreground transition hover:border-primary/35 hover:bg-background focus-visible:outline-2 focus-visible:outline-ring/60"
        key={`${id}:${start}`}
        onClick={() => onSkillPreview?.(id)}
        type="button"
      >
        <Box className="size-3.5 shrink-0" />
        <span className="truncate font-medium">{skillLabel(id)}</span>
        {skillSource(id) ? (
          <span className="shrink-0 rounded-(--radius-xs) border border-current/15 bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {skillSource(id)}
          </span>
        ) : null}
      </button>
    );
    last = start + id.length + 1;
  }
  if (parts.length === 0) return <MentionText text={text} />;
  if (last < text.length) pushText(text.slice(last), `text:${last}`);
  return <>{parts}</>;
}
