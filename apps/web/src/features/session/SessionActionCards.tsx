import type { ClarifyAsker, ClarifyForm, ClarifyRespondRequest, UrlElicitation } from '@monad/protocol';

import { ArrowUp01Icon, HelpCircleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, Textarea } from '@monad/ui';
import { memo, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { McpElicitationForm } from './McpElicitationForm';

export const ClarifyPrompt = memo(function ClarifyPrompt({
  question,
  options,
  asker,
  form,
  urlElicitation,
  onAnswer
}: {
  question: string;
  options?: string[];
  asker?: ClarifyAsker;
  form?: ClarifyForm;
  urlElicitation?: UrlElicitation;
  onAnswer: (response: Omit<ClarifyRespondRequest, 'requestId'>) => void;
}) {
  const t = useT();
  const [value, setValue] = useState('');
  const submit = (answer: string) => {
    const trimmed = answer.trim();
    if (trimmed) onAnswer({ answer: trimmed });
  };

  return (
    <div className="flex max-w-170 flex-col gap-2 self-start rounded-lg border border-info/40 bg-info/10 px-3.5 py-3">
      <div className="flex items-center gap-2 font-medium text-info text-sm">
        <HugeiconsIcon
          className="size-4"
          icon={HelpCircleIcon}
        />
        {t('web.chat.clarifyTitle')}
      </div>
      <p className="whitespace-pre-wrap text-foreground text-sm">{question}</p>
      {form && (
        <McpElicitationForm
          asker={asker}
          form={form}
          onAnswer={onAnswer}
        />
      )}
      {urlElicitation && (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-background/70 p-2.5">
          <span className="truncate font-mono text-muted-foreground text-xs">{urlElicitation.origin}</span>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => window.open(urlElicitation.url, '_blank', 'noopener,noreferrer')}
              size="sm"
              variant="outline"
            >
              {t('web.chat.urlElicitationOpen')}
            </Button>
            <Button
              onClick={() => onAnswer({ action: 'complete' })}
              size="sm"
            >
              {t('web.chat.urlElicitationDone')}
            </Button>
            <Button
              onClick={() => onAnswer({ action: 'cancel' })}
              size="sm"
              variant="ghost"
            >
              {t('web.chat.urlElicitationCancel')}
            </Button>
          </div>
        </div>
      )}
      {options && options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button
              key={option}
              onClick={() => submit(option)}
              size="sm"
              variant="outline"
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      {!urlElicitation && !form && (
        <div className="flex items-end gap-2">
          <Textarea
            className="min-h-9 flex-1 resize-none"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit(value);
              }
            }}
            placeholder={t('web.chat.clarifyPlaceholder')}
            rows={1}
            value={value}
          />
          <Button
            disabled={!value.trim()}
            onClick={() => submit(value)}
            size="sm"
          >
            <HugeiconsIcon
              className="size-4"
              icon={ArrowUp01Icon}
            />
            {t('web.chat.clarifySend')}
          </Button>
        </div>
      )}
    </div>
  );
});
