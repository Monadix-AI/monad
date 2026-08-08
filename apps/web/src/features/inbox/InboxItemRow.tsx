import type { ApprovalInboxItem, HitlInboxItem, InboxItem } from '@monad/protocol';

import { ArrowUpRight01Icon, Loading03Icon, MailOpenIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, cn } from '@monad/ui';
import { MentionText } from '@monad/ui/components/MentionText';
import { useState } from 'react';

import { AttentionStatusBadge } from '#/components/AttentionStatusBadge';
import { useT } from '#/components/I18nProvider';
import { McpElicitationForm } from '#/features/session/McpElicitationForm';
import { projectSessionPath } from '#/features/shell/routing/paths';
import { pushShellUrl } from '#/hooks/use-shell-location';

function itemTarget(item: InboxItem): string {
  const base = item.projectId ? projectSessionPath(item.projectId, item.sessionId) : `/sessions/${item.sessionId}`;
  return item.kind === 'mention' ? `${base}?msg=${encodeURIComponent(item.message.id)}` : base;
}

function formatInboxTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function inboxApprovalAction(item: ApprovalInboxItem, fallback: string): string {
  if (typeof item.input === 'object' && item.input !== null) {
    const tool = (item.input as { tool?: unknown }).tool;
    if (typeof tool === 'string' && tool) return tool;
  }
  if (item.text && item.text !== 'tool') return item.text;
  return item.tool ?? fallback;
}

function ApprovalActions({
  item,
  resolving,
  onResolve
}: {
  item: ApprovalInboxItem;
  resolving: boolean;
  onResolve: (allow: boolean) => void;
}) {
  const t = useT();
  if (item.actionState !== 'needs-response') return null;
  return (
    <div className="flex items-center gap-1.5">
      <Button
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        disabled={resolving}
        onClick={() => onResolve(false)}
        size="sm"
        type="button"
        variant="ghost"
      >
        {t('web.inbox.reject')}
      </Button>
      <Button
        disabled={resolving}
        onClick={() => onResolve(true)}
        size="sm"
        type="button"
      >
        {t('web.inbox.approve')}
      </Button>
    </div>
  );
}

function HitlActions({
  item,
  resolving,
  onAnswer
}: {
  item: HitlInboxItem;
  resolving: boolean;
  onAnswer: (answer: string) => void;
}) {
  const t = useT();
  const questions = item.questions ?? [
    {
      id: 'q1',
      question: item.question,
      options: item.options ?? [],
      mode: item.mode ?? 'single',
      allowOther: item.allowOther ?? true
    }
  ];
  const [questionIndex, setQuestionIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, { selected: string[]; other: string }>>({});
  if (item.actionState !== 'needs-response') {
    return item.answer ? (
      <div className="rounded-(--radius-sm) bg-muted/60 px-3 py-2 text-sm">{item.answer}</div>
    ) : null;
  }
  if (item.form) {
    return (
      <McpElicitationForm
        asker={item.asker}
        form={item.form}
        onAnswer={(response) => onAnswer(response.answer ?? '')}
      />
    );
  }
  const question = questions[questionIndex] ?? questions[0];
  if (!question) return null;
  const draft = drafts[question.id] ?? { selected: [], other: '' };
  const multiple = question.mode === 'multiple';
  const selected = draft.selected;
  const other = draft.other;
  const hasAnswer = selected.length > 0 || other.trim().length > 0;
  const answerFor = (candidate: { selected: string[]; other: string }, isMultiple: boolean) => {
    const values = [...candidate.selected, ...(candidate.other.trim() ? [candidate.other.trim()] : [])];
    return isMultiple ? values : (values[0] ?? '');
  };
  const updateDraft = (next: { selected: string[]; other: string }) => {
    setDrafts((current) => ({ ...current, [question.id]: next }));
  };
  const toggle = (option: string) => {
    updateDraft({
      selected: multiple
        ? selected.includes(option)
          ? selected.filter((value) => value !== option)
          : [...selected, option]
        : [option],
      other: multiple ? other : ''
    });
  };
  const submit = () => {
    if (questionIndex < questions.length - 1) {
      setQuestionIndex((index) => index + 1);
      return;
    }
    if (questions.length === 1) {
      const answer = answerFor(draft, multiple);
      onAnswer(typeof answer === 'string' ? answer : JSON.stringify(answer));
      return;
    }
    const answers = Object.fromEntries(
      questions.map((candidate) => [
        candidate.id,
        answerFor(drafts[candidate.id] ?? { selected: [], other: '' }, candidate.mode === 'multiple')
      ])
    );
    onAnswer(JSON.stringify(answers));
  };
  return (
    <div className="flex flex-col gap-2">
      {questions.length > 1 ? (
        <div className="text-muted-foreground text-xs">{`${questionIndex + 1}/${questions.length} · ${question.question}`}</div>
      ) : null}
      {question.options.length ? (
        <div className="flex flex-wrap gap-2">
          {question.options.map((option) => (
            <button
              aria-pressed={selected.includes(option)}
              className={cn(
                'rounded-full border px-3 py-1.5 text-xs transition',
                selected.includes(option)
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border hover:bg-accent'
              )}
              key={option}
              onClick={() => toggle(option)}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {question.allowOther || !question.options.length ? (
        <textarea
          className="min-h-20 resize-y rounded-(--radius-sm) border border-border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
          onChange={(event) => updateDraft({ ...draft, other: event.target.value })}
          placeholder={t('web.inbox.answerPlaceholder')}
          value={other}
        />
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          className="rounded-(--radius-sm) px-3 py-1.5 text-muted-foreground text-xs"
          disabled={resolving}
          onClick={() => onAnswer('')}
          type="button"
        >
          {t('web.inbox.skip')}
        </button>
        {questionIndex > 0 ? (
          <button
            className="rounded-(--radius-sm) border border-border px-3 py-1.5 text-xs"
            disabled={resolving}
            onClick={() => setQuestionIndex((index) => index - 1)}
            type="button"
          >
            {t('web.common.back')}
          </button>
        ) : null}
        <Button
          disabled={resolving || !hasAnswer}
          onClick={submit}
          size="sm"
          type="button"
        >
          {questionIndex === questions.length - 1 ? t('web.inbox.sendAnswer') : t('web.common.next')}
        </Button>
      </div>
    </div>
  );
}

export function InboxItemRow({
  item,
  resolving,
  markingUnread,
  onResolveApproval,
  onAnswer,
  onMarkUnread
}: {
  item: InboxItem;
  resolving: boolean;
  markingUnread: boolean;
  onResolveApproval: (item: ApprovalInboxItem, allow: boolean) => void;
  onAnswer: (item: HitlInboxItem, answer: string) => void;
  onMarkUnread: (item: InboxItem) => void;
}) {
  const t = useT();
  const title = item.projectName ?? item.sessionTitle ?? t('web.inbox.unknownContext');
  const actor =
    item.kind === 'mention'
      ? item.agentName
      : item.kind === 'hitl'
        ? item.asker?.name
        : item.approvalKind === 'mesh-agent'
          ? item.provider
          : item.tool;
  const actorLabel = actor ? (item.kind === 'mention' ? `@${actor}` : actor) : null;
  const preview =
    item.kind === 'mention' ? (
      <MentionText text={item.message.text} />
    ) : item.kind === 'hitl' ? (
      item.question
    ) : (
      t('web.inbox.approvalPreview', {
        action: inboxApprovalAction(item, t('web.inbox.approvalRequest'))
      })
    );
  const statusLabel =
    item.actionState === 'needs-response'
      ? item.kind === 'approval'
        ? t('web.inbox.approvalNeeded')
        : t('web.inbox.needResponse')
      : item.actionState === 'completed'
        ? t('web.inbox.resolved')
        : item.actionState === 'timed-out'
          ? t('web.inbox.timedOut')
          : item.actionState === 'cancelled'
            ? t('web.inbox.cancelled')
            : null;
  return (
    <article
      className={cn(
        'relative flex w-full flex-col gap-3 rounded-(--radius-md) border bg-card px-4 py-4 text-left shadow-[0_1px_2px_rgb(0_0_0/0.035)] transition-[border-color,background-color] duration-150 ease-out',
        item.readAt ? 'border-border/60' : 'border-primary/35',
        item.kind === 'approval' && item.actionState === 'needs-response' && 'border-warning/35 bg-warning/[0.025]'
      )}
    >
      <header
        className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between"
        data-inbox-card-header="true"
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {!item.readAt ? (
              <>
                <span className="sr-only">{t('web.inbox.unread')}</span>
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full bg-primary"
                />
              </>
            ) : null}
            <h2 className="min-w-0 flex-1 truncate font-medium text-sm">{title}</h2>
          </div>
          <div
            className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-muted-foreground text-xs"
            data-inbox-card-meta="true"
          >
            {statusLabel ? (
              <AttentionStatusBadge state={item.actionState === 'needs-response' ? 'need-response' : 'completed'}>
                {statusLabel}
              </AttentionStatusBadge>
            ) : null}
            {actorLabel ? <span className="max-w-56 truncate">{actorLabel}</span> : null}
            {actorLabel ? <span aria-hidden="true">·</span> : null}
            <time className="shrink-0 tabular-nums">{formatInboxTime(item.createdAt)}</time>
          </div>
        </div>
        <div
          className="flex shrink-0 flex-wrap items-center gap-1 lg:justify-end"
          data-inbox-card-actions="true"
        >
          <Button
            onClick={() => pushShellUrl(itemTarget(item))}
            size="sm"
            type="button"
            variant="ghost"
          >
            <HugeiconsIcon
              aria-hidden="true"
              icon={ArrowUpRight01Icon}
            />
            {t('web.inbox.openSession')}
          </Button>
          {item.readAt ? (
            <Button
              disabled={markingUnread}
              onClick={() => onMarkUnread(item)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <HugeiconsIcon
                aria-hidden="true"
                className={cn(markingUnread && 'animate-spin motion-reduce:animate-none')}
                icon={markingUnread ? Loading03Icon : MailOpenIcon}
              />
              {t('web.inbox.markUnread')}
            </Button>
          ) : null}
          {item.kind === 'approval' ? (
            <ApprovalActions
              item={item}
              onResolve={(allow) => onResolveApproval(item, allow)}
              resolving={resolving}
            />
          ) : null}
        </div>
      </header>
      <div className="text-[0.9375rem] text-foreground leading-relaxed">{preview}</div>
      {item.kind === 'hitl' ? (
        <HitlActions
          item={item}
          onAnswer={(answer) => onAnswer(item, answer)}
          resolving={resolving}
        />
      ) : null}
    </article>
  );
}
