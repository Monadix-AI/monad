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
    streaming: boolean;
    text: string;
  };
  streaming: boolean;
  text: string;
  timestamp?: string;
};

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
  const hasReasoningContent = reasoningState?.hasContent ?? !!reasoningState?.text.trim();
  const reasoningBody = reasoningState ? (
    <Reasoning
      className={messageRole === 'reasoning' ? 'mb-0 w-full' : 'mb-2 w-full'}
      defaultOpen={false}
      duration={reasoningState.durationMs === undefined ? undefined : Math.ceil(reasoningState.durationMs / 1000)}
      isStreaming={reasoningState.streaming}
    >
      <ReasoningTrigger
        className="text-xs disabled:pointer-events-none"
        disabled={!hasReasoningContent}
        hideChevron={!hasReasoningContent}
        labels={{
          thinking: t('web.reasoning.thinking'),
          thoughtFew: t('web.reasoning.thoughtFew'),
          thoughtSeconds: (seconds) => t('web.reasoning.thoughtSeconds', { count: seconds })
        }}
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
        className="group/observation-message mb-4 w-full min-w-0 max-w-full"
        data-message-presentation="plain"
        data-slot="observation-agent-message"
      >
        <div className="w-full max-w-[min(72ch,100%)] font-sans text-foreground text-sm leading-6">{body}</div>
        {messageRole === 'agent' && timestampLabel ? (
          <footer className="mt-1 w-full max-w-[min(72ch,100%)] opacity-0 transition-opacity group-focus-within/observation-message:opacity-100 group-hover/observation-message:opacity-100">
            <time style={TIME_STYLE}>{timestampLabel}</time>
          </footer>
        ) : null}
      </article>
    );
  }

  return (
    <WorkspaceMessageCard
      align="end"
      avatar={null}
      body={body}
      bodyClassName="text-sm leading-6"
      header={null}
      tone="human"
    />
  );
}
