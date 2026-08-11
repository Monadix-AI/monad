import { formatMessageTimestamp, Reasoning, ReasoningContent, ReasoningTrigger, WorkspaceMessageCard } from '@monad/ui';
import { MentionText } from '@monad/ui/components/MentionText';

import { workplaceExperienceLocale, workplaceExperienceT } from '../../../i18n.ts';
import { MarkdownWithMentions } from '../message-row.tsx';
import { TIME_STYLE } from '../system-message-row.tsx';

export type ObservationMessageCardProps = {
  messageRole: 'agent' | 'reasoning' | 'user';
  reasoning?: {
    durationMs?: number;
    hasContent?: boolean;
    summary?: string;
    streaming: boolean;
    text: string;
  };
  streaming: boolean;
  text: string;
  timestamp?: string;
};

export function observationReasoningTitle(summary: string | undefined): string | undefined {
  const titles = summary
    ?.split(/\n\s*\n/)
    .map((part) => {
      const title = part.trim();
      const emphasized = /^(\*\*|__)([\s\S]*?)\1$/.exec(title);
      return emphasized?.[2]?.trim() || title;
    })
    .filter(Boolean);
  return titles && titles.length > 0 ? titles.join(' · ') : undefined;
}

export function ObservationMessageCard({
  messageRole,
  reasoning,
  streaming,
  text,
  timestamp
}: ObservationMessageCardProps): React.ReactElement {
  const t = workplaceExperienceT();
  const locale = workplaceExperienceLocale();
  const user = messageRole === 'user';
  const timestampLabel = formatMessageTimestamp(timestamp, locale);
  const reasoningState = messageRole === 'reasoning' ? { streaming, text, ...reasoning } : reasoning;
  const reasoningTitle = observationReasoningTitle(reasoningState?.summary);
  const reasoningTriggerTitle =
    reasoningTitle && reasoningState?.streaming ? `${t('web.reasoning.thinking')} ${reasoningTitle}` : reasoningTitle;
  const hasReasoningContent = reasoningState?.hasContent ?? !!reasoningState?.text.trim();
  const reasoningBody = reasoningState ? (
    <Reasoning
      className={messageRole === 'reasoning' ? 'mb-0 w-full' : 'mb-2 w-full'}
      defaultOpen={false}
      duration={reasoningState.durationMs === undefined ? undefined : Math.ceil(reasoningState.durationMs / 1000)}
      isStreaming={reasoningState.streaming}
    >
      <ReasoningTrigger
        className="min-h-6 min-w-0 overflow-hidden px-0 py-0 font-sans text-muted-foreground text-sm leading-5 disabled:pointer-events-none"
        disabled={!hasReasoningContent}
        getThinkingMessage={
          reasoningTriggerTitle ? () => <p className="min-w-0 truncate">{reasoningTriggerTitle}</p> : undefined
        }
        hideChevron={!hasReasoningContent}
        iconClassName="shrink-0"
        labels={{
          thinking: t('web.reasoning.thinking'),
          thoughtFew: t('web.reasoning.thoughtFew'),
          thoughtSeconds: (seconds) => t('web.reasoning.thoughtSeconds', { count: seconds })
        }}
        orbState={reasoningState?.streaming ? 'working' : undefined}
      />
      {hasReasoningContent ? (
        <ReasoningContent className="mt-2 max-h-48 overflow-y-auto overscroll-contain text-xs">
          {reasoningState.text}
        </ReasoningContent>
      ) : null}
    </Reasoning>
  ) : null;
  const body =
    messageRole === 'reasoning' ? (
      reasoningBody
    ) : user ? (
      <MentionText text={text} />
    ) : (
      <>
        {reasoningBody}
        <MarkdownWithMentions
          streaming={streaming}
          text={text}
        />
      </>
    );

  if (!user) {
    return (
      <article
        className="group/observation-message w-full min-w-0 max-w-full"
        data-message-presentation="plain"
        data-slot="observation-agent-message"
      >
        <div className="w-full max-w-[min(72ch,100%)] font-sans text-foreground text-sm leading-6">{body}</div>
        {timestampLabel ? (
          <footer className="mt-1 w-full max-w-[min(72ch,100%)] opacity-0 group-focus-within/observation-message:opacity-100 group-hover/observation-message:opacity-100">
            <time style={TIME_STYLE}>{timestampLabel}</time>
          </footer>
        ) : null}
      </article>
    );
  }

  return (
    <div
      className="group/observation-message flex w-full min-w-0 flex-col items-end"
      data-slot="observation-user-message"
    >
      <WorkspaceMessageCard
        align="end"
        avatar={null}
        body={body}
        bodyClassName="text-sm leading-6"
        header={null}
        tone="human"
      />
      {timestampLabel ? (
        <footer className="-mt-3 mb-1 opacity-0 group-focus-within/observation-message:opacity-100 group-hover/observation-message:opacity-100">
          <time style={TIME_STYLE}>{timestampLabel}</time>
        </footer>
      ) : null}
    </div>
  );
}
