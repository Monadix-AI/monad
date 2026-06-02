import type { ClarifyRespondRequest } from '@monad/protocol';
import type { PendingClarification } from './session-route-contract';

import { HelpCircleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ComposerAskSheet } from '@monad/ui';

import { useT } from '#/components/I18nProvider';
import { ClarifyPrompt } from './SessionActionCards';

export function SessionClarificationSheet({
  assistantLabel,
  clarification,
  onAnswer,
  total
}: {
  assistantLabel: string;
  clarification: PendingClarification;
  onAnswer: (response: Omit<ClarifyRespondRequest, 'requestId'>) => void;
  total: number;
}) {
  const t = useT();

  if (clarification.form || clarification.urlElicitation) {
    return (
      <ClarifyPrompt
        asker={clarification.asker}
        form={clarification.form}
        onAnswer={onAnswer}
        options={clarification.options}
        question={clarification.question}
        urlElicitation={clarification.urlElicitation}
      />
    );
  }

  const askerName = clarification.asker?.name ?? assistantLabel;
  return (
    <ComposerAskSheet
      askedLabel={t('web.chat.clarifyTitle')}
      asker={
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-info/12 text-info">
            <HugeiconsIcon
              aria-hidden="true"
              className="size-3.5"
              icon={HelpCircleIcon}
            />
          </span>
          <span className="truncate font-medium text-[13px]">{askerName}</span>
        </div>
      }
      backLabel={t('web.common.back')}
      buildAnswer={(selected, other) => {
        const values = [...selected, ...(other.trim() ? [other.trim()] : [])];
        return values.length ? values.join('\n') : null;
      }}
      dismissLabel={t('web.inbox.skip')}
      key={clarification.requestId}
      nextLabel={t('web.common.next')}
      onAnswer={(_requestId, answer) => onAnswer({ answer })}
      onDismiss={() => onAnswer({ action: 'cancel' })}
      otherAriaLabel={t('web.chat.clarifyPlaceholder')}
      otherPlaceholder={t('web.chat.clarifyPlaceholder')}
      position={1}
      question={{
        allowOther: true,
        id: clarification.requestId,
        mode: 'single',
        options: clarification.options ?? [],
        question: clarification.question
      }}
      submitLabel={t('web.chat.clarifySend')}
      total={total}
    />
  );
}
