import { Reasoning, ReasoningContent, ReasoningTrigger, WorkspaceMessageCard } from '@monad/ui';
import { MentionText } from '@monad/ui/components/MentionText';

import { workplaceExperienceT } from '../../../i18n.ts';
import { MarkdownWithMentions } from '../message-row.tsx';
import { TIME_STYLE } from '../system-message-row.tsx';

export type ObservationMessageCardProps = {
  messageRole: 'agent' | 'reasoning' | 'user';
  reasoning?: {
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
  const user = messageRole === 'user';
  const reasoningState = messageRole === 'reasoning' ? { streaming, text } : reasoning;
  const reasoningBody = reasoningState ? (
    <Reasoning
      className={messageRole === 'reasoning' ? 'mb-0 w-full' : 'mb-2 w-full'}
      defaultOpen={false}
      isStreaming={reasoningState.streaming}
    >
      <ReasoningTrigger
        className="text-xs"
        labels={{
          thinking: t('web.reasoning.thinking'),
          thoughtFew: t('web.reasoning.thoughtFew'),
          thoughtSeconds: (seconds) => t('web.reasoning.thoughtSeconds', { seconds })
        }}
      />
      <ReasoningContent className="mt-2 max-h-48 overflow-y-auto overscroll-contain text-xs">
        {reasoningState.text}
      </ReasoningContent>
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
        className="mb-4 w-full min-w-0 max-w-full"
        data-message-presentation="plain"
        data-slot="observation-agent-message"
      >
        {timestamp ? (
          <header className="mb-1 w-full max-w-[min(72ch,100%)]">
            <span style={TIME_STYLE}>{timestamp}</span>
          </header>
        ) : null}
        <div className="w-full max-w-[min(72ch,100%)] font-sans text-foreground text-sm leading-6">{body}</div>
      </article>
    );
  }

  return (
    <WorkspaceMessageCard
      align="end"
      avatar={null}
      body={body}
      bodyClassName="text-sm leading-6"
      header={timestamp ? <span style={TIME_STYLE}>{timestamp}</span> : null}
      tone="human"
    />
  );
}
