import { formatMessageTimestamp, Reasoning, ReasoningContent, ReasoningTrigger, WorkspaceMessageCard } from '@monad/ui';
import { MentionText } from '@monad/ui/components/MentionText';

import { workplaceExperienceLocale, workplaceExperienceT } from '../../../i18n.ts';
import { MarkdownWithMentions } from '../message-row.tsx';
import { TIME_STYLE } from '../system-message-row.tsx';
import { useObservationDisclosure } from './disclosure.tsx';

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

function observationReasoningSummaries(summary: string | undefined): string[] {
  return (
    summary
      ?.split(/\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean) ?? []
  );
}

export function observationReasoningTitle(summary: string | undefined): string | undefined {
  const summaries = observationReasoningSummaries(summary);
  if (summaries.length !== 1) return undefined;
  const title = summaries[0];
  if (!title) return undefined;
  const emphasized = /^(\*\*|__)([\s\S]*?)\1$/.exec(title);
  return emphasized?.[2]?.trim() || title;
}

export function observationReasoningTokenCount(summary: string | undefined): number | undefined {
  const match = /thinking(?:…|\.\.\.)\s+([\d,]+)\s+tokens?\s*$/i.exec(summary?.trim() ?? '');
  if (!match?.[1]) return undefined;
  const count = Number(match[1].replaceAll(',', ''));
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

export function observationReasoningContent(summary: string | undefined, text: string): string {
  return observationReasoningSummaries(summary).length > 1 && observationReasoningTokenCount(summary) === undefined
    ? (summary?.trim() ?? text)
    : text;
}

function normalizedReasoningText(text: string): string {
  const trimmed = text.trim();
  const emphasized = /^(\*\*|__)([\s\S]*?)\1$/.exec(trimmed);
  return (emphasized?.[2] ?? trimmed).trim();
}

export function observationReasoningHasContent(
  summary: string | undefined,
  text: string,
  hasContent: boolean | undefined
): boolean {
  const summaries = observationReasoningSummaries(summary);
  if (summaries.length > 1 && observationReasoningTokenCount(summary) === undefined) return true;
  if (hasContent === false) return false;

  const content = normalizedReasoningText(observationReasoningContent(summary, text));
  if (!content || /^thinking(?:…|\.\.\.)$/i.test(content)) return false;
  if (summaries.length !== 1) return true;
  return content !== normalizedReasoningText(summaries[0] ?? '');
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
  const reasoningTokenCount = observationReasoningTokenCount(reasoningState?.summary);
  const reasoningContent = observationReasoningContent(reasoningState?.summary, reasoningState?.text ?? '');
  const [reasoningOpen, setReasoningOpen] = useObservationDisclosure('reasoning');
  const hasReasoningContent = observationReasoningHasContent(
    reasoningState?.summary,
    reasoningState?.text ?? '',
    reasoningState?.hasContent
  );
  const reasoningBody = reasoningState ? (
    <Reasoning
      className={messageRole === 'reasoning' ? 'mb-0 w-full' : 'mb-2 w-full'}
      defaultOpen={false}
      duration={reasoningState.durationMs === undefined ? undefined : Math.ceil(reasoningState.durationMs / 1000)}
      isStreaming={reasoningState.streaming}
      onOpenChange={setReasoningOpen}
      open={reasoningOpen}
    >
      <ReasoningTrigger
        className="min-h-6 min-w-0 overflow-hidden px-0 py-0 font-ui text-muted-foreground text-sm leading-5 disabled:pointer-events-none"
        disabled={!hasReasoningContent}
        getThinkingMessage={
          reasoningTitle
            ? (isStreaming, duration) => (
                <p className="min-w-0 truncate">
                  {isStreaming
                    ? `${t('web.reasoning.thinking')} ${duration ?? 0}s · ${
                        reasoningTokenCount === undefined
                          ? reasoningTitle
                          : t('web.model.tok', { count: reasoningTokenCount })
                      }`
                    : `${
                        duration === undefined
                          ? t('web.reasoning.thoughtFew')
                          : t('web.reasoning.thoughtSeconds', { count: duration })
                      } · ${
                        reasoningTokenCount === undefined
                          ? reasoningTitle
                          : t('web.model.tok', { count: reasoningTokenCount })
                      }`}
                </p>
              )
            : undefined
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
          {reasoningContent}
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
        <div className="w-full max-w-[min(72ch,100%)] font-ui text-foreground text-sm leading-6">{body}</div>
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
