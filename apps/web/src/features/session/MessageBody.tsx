import type { Card, ClientRenderCaps, CommandItem } from '@monad/protocol';
import type { ComponentType, ReactNode } from 'react';

import { isHttpUrl, type ProviderConfigError, pickRepresentation } from '@monad/protocol';
import { Button, cn, faviconMarkdownComponents } from '@monad/ui';
import { ComposerInlineChip } from '@monad/ui/components/ComposerInlineChip';
import { Markdown } from '@monad/ui/components/Markdown';
import { MentionText } from '@monad/ui/components/MentionText';

import { useT } from '#/components/I18nProvider';
import { ShellLink } from '#/components/ShellLink';
import { studioPath } from '#/features/shell/routing/paths';
import { useOptionalSessionContext } from './session-context';

// Tool calls/results are NOT here — they are paired into inline ToolStepView items upstream in
// chat.tsx's viewMessages and never reach MessageBody. This client owns the `card` and
// `provider_config_error` renderers; everything else degrades to markdown/text via the shared registry.
const WEB_RENDER_CAPS: ClientRenderCaps = {
  richTypes: new Set(['card', 'provider_config_error']),
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
      <Markdown
        components={faviconMarkdownComponents}
        text={card.body ?? text}
      />
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

// Generation failed because the model provider isn't set up (missing credentials, or the
// provider doesn't support the requested capability) — not something the user can retry their
// way out of. The specific cause is intentionally not distinguished here: it's in `text` below.
function ProviderConfigErrorRenderer({ data, text }: RichRendererProps) {
  const t = useT();
  const { providerId } = (data ?? {}) as ProviderConfigError;
  return (
    <div className="flex flex-col gap-2">
      <div className="font-semibold text-sm">{t('web.providerConfigError.title')}</div>
      <p className="text-foreground/85">
        {providerId ? t('web.providerConfigError.bodyWithProvider', { providerId }) : t('web.providerConfigError.body')}
      </p>
      <div>
        <Button
          asChild
          size="sm"
          variant="secondary"
        >
          <ShellLink href={studioPath('models')}>{t('web.providerConfigError.action')}</ShellLink>
        </Button>
      </div>
      {text && (
        <details className="text-muted-foreground text-xs">
          <summary className="cursor-pointer select-none">{t('web.providerConfigError.detailsLabel')}</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono">{text}</pre>
        </details>
      )}
    </div>
  );
}

/** type → rich `data` renderer. Keyed by the message `type` (built-in or `atomPackId:type`). */
const MESSAGE_RENDERERS: Record<string, ComponentType<RichRendererProps>> = {
  card: CardRenderer,
  provider_config_error: ProviderConfigErrorRenderer
};

/** Render a message body, degrading by type against this client's capabilities. `data` + `markdown`
 * representations both render through Markdown (which handles plain text), so non-rich types look
 * exactly as before; only a type with a registered renderer and a satisfied `data` chain renders rich. */
export function MessageBody({
  type,
  text,
  data,
  isUser,
  commands,
  onSkillPreview
}: {
  commands?: CommandItem[];
  type?: string;
  text: string;
  data?: unknown;
  isUser: boolean;
  onSkillPreview?: (id: string) => void;
}) {
  const sessionContext = useOptionalSessionContext();
  const resolvedCommands = commands ?? sessionContext?.commands;
  const resolvedOnSkillPreview = onSkillPreview ?? sessionContext?.onSkillPreview;
  if (isUser)
    return (
      <span className={cn('whitespace-pre-wrap')}>
        <UserMessageText
          commands={resolvedCommands}
          onSkillPreview={resolvedOnSkillPreview}
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
  return (
    <Markdown
      components={faviconMarkdownComponents}
      text={text}
    />
  );
}

function skillLabel(id: string): string {
  const parts = id.split(':');
  if (parts.length === 2 && parts[0] === 'global') return parts[1] ?? id;
  if (parts.length === 3 && (parts[0] === 'atom-pack' || parts[0] === 'agent')) return parts[2] ?? id;
  return id;
}

type UserMessageToken = {
  end: number;
  icon?: string;
  id: string;
  kind: 'command' | 'skill';
  label: string;
  start: number;
};

export function userMessageTokens(text: string, commands: CommandItem[] = []): UserMessageToken[] {
  const tokens: UserMessageToken[] = [];
  const commandMatch = /^\s*\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/.exec(text);
  if (commandMatch) {
    const id = commandMatch[1] as string;
    const command = commands.find((item) => item.enabled && item.type === 'action' && item.id === id);
    if (command) {
      const start = commandMatch[0].lastIndexOf('/');
      tokens.push({ end: start + id.length + 1, id, kind: 'command', label: command.name, start });
    }
  }
  const skillRe =
    /\/((?:global:[a-z0-9-]+)|(?:atom-pack:[a-z0-9-]+:[a-z0-9-]+)|(?:agent:[a-z0-9-]+:[a-z0-9-]+))(?=\s|$)/g;
  for (const match of text.matchAll(skillRe)) {
    const id = match[1] as string;
    const start = match.index ?? 0;
    const command = commands.find((item) => item.type === 'skill' && item.id === id);
    tokens.push({
      end: start + id.length + 1,
      icon: command?.icon,
      id,
      kind: 'skill',
      label: command?.name ?? skillLabel(id),
      start
    });
  }
  return tokens.sort((a, b) => a.start - b.start);
}

function UserMessageText({
  commands,
  text,
  onSkillPreview
}: {
  commands?: CommandItem[];
  text: string;
  onSkillPreview?: (id: string) => void;
}) {
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
  for (const token of userMessageTokens(text, commands)) {
    if (token.start > last) pushText(text.slice(last, token.start), `text:${last}`);
    parts.push(
      <ComposerInlineChip
        icon={token.icon}
        key={`${token.kind}:${token.id}:${token.start}`}
        kind={token.kind}
        label={token.label}
        onClick={token.kind === 'skill' && onSkillPreview ? () => onSkillPreview(token.id) : undefined}
      />
    );
    last = token.end;
  }
  if (parts.length === 0) return <MentionText text={text} />;
  if (last < text.length) pushText(text.slice(last), `text:${last}`);
  return <>{parts}</>;
}
