import type { ReactElement, ReactNode } from 'react';

import { useEffect, useMemo, useRef, useState } from 'react';

import { keyedOptions } from '../lib/keyed-options';

const closeMs = 180;

export type ComposerAskSheetQuestion = {
  allowOther?: boolean;
  id: string;
  mode: 'single' | 'multiple';
  options: string[];
  question: string;
};

export type ComposerAskSheetProps = {
  askedLabel: string;
  asker: ReactNode;
  buildAnswer: (selected: string[], other: string, multiple: boolean) => string | null;
  backLabel: string;
  dismissLabel: string;
  otherAriaLabel: string;
  otherPlaceholder: string;
  onAnswer: (requestId: string, answer: string) => void;
  onDismiss: (requestId: string) => void;
  nextLabel: string;
  position: number;
  question: ComposerAskSheetQuestion;
  questions?: ComposerAskSheetQuestion[];
  submitLabel: string;
  total: number;
};

type ComposerAskSheetKeyAction =
  | { type: 'choose'; index: number }
  | { type: 'dismiss' | 'focus-next' | 'focus-previous' | 'ignore' | 'submit' | 'toggle-active' };

export function composerAskSheetKeyAction(input: {
  inTextInput: boolean;
  isComposing: boolean;
  key: string;
  primaryModifier: boolean;
}): ComposerAskSheetKeyAction {
  if (input.isComposing) return { type: 'ignore' };
  if (input.inTextInput) {
    if (input.key === 'Escape') return { type: 'dismiss' };
    if (input.key === 'Enter' && input.primaryModifier) return { type: 'submit' };
    return { type: 'ignore' };
  }
  if (/^[1-9]$/.test(input.key)) return { type: 'choose', index: Number(input.key) - 1 };
  if (input.key === 'ArrowDown') return { type: 'focus-next' };
  if (input.key === 'ArrowUp') return { type: 'focus-previous' };
  if (input.key === ' ') return { type: 'toggle-active' };
  if (input.key === 'Enter') return { type: 'submit' };
  if (input.key === 'Escape') return { type: 'dismiss' };
  return { type: 'ignore' };
}

export function ComposerAskSheet({
  askedLabel,
  asker,
  backLabel,
  buildAnswer,
  dismissLabel,
  onAnswer,
  onDismiss,
  nextLabel,
  otherAriaLabel,
  otherPlaceholder,
  position,
  question,
  questions,
  submitLabel,
  total
}: ComposerAskSheetProps): ReactElement {
  const cardQuestions = questions?.length ? questions : [question];
  const [questionIndex, setQuestionIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, { selected: string[]; other: string }>>({});
  const [active, setActive] = useState(0);
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLFieldSetElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);
  const currentQuestion = cardQuestions[questionIndex] ?? question;
  const draft = drafts[currentQuestion.id] ?? { selected: [], other: '' };
  const multiple = currentQuestion.mode === 'multiple';
  const focusableCount = currentQuestion.options.length + (currentQuestion.allowOther ? 1 : 0);
  const canContinue = draft.selected.length > 0 || draft.other.trim().length > 0;
  const onLastQuestion = questionIndex === cardQuestions.length - 1;
  const optionsByIndex = useMemo(
    () => new Map(currentQuestion.options.map((option, index) => [index, option])),
    [currentQuestion]
  );

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const updateDraft = (
    update: (current: { selected: string[]; other: string }) => { selected: string[]; other: string }
  ) => {
    setDrafts((current) => ({
      ...current,
      [currentQuestion.id]: update(current[currentQuestion.id] ?? { selected: [], other: '' })
    }));
  };

  const choose = (option: string): void => {
    updateDraft((current) => {
      const selected = multiple
        ? current.selected.includes(option)
          ? current.selected.filter((item) => item !== option)
          : [...current.selected, option]
        : [option];
      return { ...current, selected };
    });
  };

  const chooseIndex = (index: number): void => {
    const option = optionsByIndex.get(index);
    if (option) {
      choose(option);
      return;
    }
    if (currentQuestion.allowOther && index === currentQuestion.options.length) otherRef.current?.focus();
  };

  const complete = (callback: () => void): void => {
    setClosing(true);
    window.setTimeout(callback, closeMs);
  };

  const submit = (): void => {
    let answer = buildAnswer(draft.selected, draft.other, multiple);
    if (!answer && !multiple) {
      const option = optionsByIndex.get(active);
      if (option) {
        answer = buildAnswer([option], draft.other, multiple);
        updateDraft((current) => ({ ...current, selected: [option] }));
      }
    }
    if (answer === null) return;
    if (!onLastQuestion) {
      setActive(0);
      setQuestionIndex((index) => index + 1);
      return;
    }
    if (cardQuestions.length === 1) {
      complete(() => onAnswer(question.id, answer));
      return;
    }
    const answers = Object.fromEntries(
      cardQuestions.map((item) => {
        const itemDraft = item.id === currentQuestion.id ? draft : (drafts[item.id] ?? { selected: [], other: '' });
        if (item.mode === 'multiple') {
          return [item.id, [...itemDraft.selected, ...(itemDraft.other.trim() ? [itemDraft.other.trim()] : [])]];
        }
        return [item.id, buildAnswer(itemDraft.selected, itemDraft.other, false) ?? ''];
      })
    );
    complete(() => onAnswer(question.id, JSON.stringify(answers)));
  };

  const dismiss = (): void => {
    complete(() => onDismiss(question.id));
  };

  return (
    <fieldset
      className={closing ? 'monad-ui-question-sheet is-closing' : 'monad-ui-question-sheet'}
      onKeyDown={(event) => {
        const action = composerAskSheetKeyAction({
          inTextInput: event.target instanceof HTMLInputElement,
          isComposing: event.nativeEvent.isComposing,
          key: event.key,
          primaryModifier: event.metaKey || event.ctrlKey
        });
        if (action.type === 'ignore') return;
        event.preventDefault();
        switch (action.type) {
          case 'choose':
            chooseIndex(action.index);
            return;
          case 'focus-next':
            setActive((index) => (focusableCount ? (index + 1) % focusableCount : 0));
            return;
          case 'focus-previous':
            setActive((index) => (focusableCount ? (index - 1 + focusableCount) % focusableCount : 0));
            return;
          case 'toggle-active':
            chooseIndex(active);
            return;
          case 'submit':
            submit();
            return;
          case 'dismiss':
            dismiss();
        }
      }}
      ref={panelRef}
      style={{
        background: 'var(--popover)',
        border: 'none',
        display: 'grid',
        gap: 10,
        margin: '0 auto',
        overflow: 'visible',
        padding: '2px 6px 6px',
        width: '100%'
      }}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the sheet owns scoped keyboard shortcuts while it is open.
      tabIndex={0}
    >
      <legend
        style={{
          height: 1,
          left: -10_000,
          overflow: 'hidden',
          position: 'absolute',
          top: 'auto',
          width: 1
        }}
      >
        {currentQuestion.question}
      </legend>
      <style>{`
        .monad-ui-question-sheet {
          animation: monadUiQuestionIn 220ms cubic-bezier(.16,1,.3,1) both;
          transform-origin: bottom center;
        }
        .monad-ui-question-sheet.is-closing {
          animation: monadUiQuestionOut ${closeMs}ms cubic-bezier(.7,0,.84,0) both;
        }
        @keyframes monadUiQuestionIn {
          0% { opacity: 0; transform: translateY(18px) scale(.985); filter: blur(2px); }
          100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
        }
        @keyframes monadUiQuestionOut {
          0% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
          100% { opacity: 0; transform: translateY(14px) scale(.99); filter: blur(1px); }
        }
        .monad-ui-question-choice:hover:not(:disabled) {
          background: color-mix(in srgb, var(--foreground) 6%, transparent) !important;
          border-color: color-mix(in srgb, var(--foreground) 24%, var(--border)) !important;
        }
        .monad-ui-question-other:focus-within {
          border-color: var(--ring) !important;
          box-shadow: 0 0 0 1px var(--ring);
        }
        @media (prefers-reduced-motion: reduce) {
          .monad-ui-question-sheet,
          .monad-ui-question-sheet.is-closing {
            animation: none;
          }
        }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {asker}
          <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>{askedLabel}</span>
        </div>
        {cardQuestions.length > 1 || total > 1 ? (
          <span
            style={{
              color: 'var(--muted-foreground)',
              flex: 'none',
              fontFamily: 'var(--font-ui)',
              fontSize: 11
            }}
          >
            {cardQuestions.length > 1 ? `${questionIndex + 1}/${cardQuestions.length}` : `${position}/${total}`}
          </span>
        ) : null}
      </div>
      <div
        style={{
          display: 'grid',
          gap: 10,
          maxHeight: 'min(38vh, 320px)',
          minHeight: 0,
          overflowY: 'auto',
          padding: '1px 1px 1px 0'
        }}
      >
        <p
          style={{
            color: 'var(--foreground)',
            fontSize: 15,
            fontWeight: 600,
            lineHeight: 1.45,
            margin: 0,
            textWrap: 'pretty'
          }}
        >
          {currentQuestion.question}
        </p>
        {currentQuestion.options.length ? (
          <div style={{ display: 'grid', gap: 6 }}>
            {keyedOptions(currentQuestion.options).map(({ key, option }, index) => {
              const selected = draft.selected.includes(option);
              const highlighted = active === index;
              return (
                <button
                  aria-pressed={selected}
                  className="monad-ui-question-choice workplace-action"
                  key={key}
                  onClick={() => choose(option)}
                  onMouseEnter={() => setActive(index)}
                  style={{
                    alignItems: 'start',
                    background: selected
                      ? 'color-mix(in srgb, var(--accent-blue) 12%, transparent)'
                      : highlighted
                        ? 'color-mix(in srgb, var(--foreground) 5%, transparent)'
                        : 'transparent',
                    border: `1px solid ${
                      selected ? 'color-mix(in srgb, var(--accent-blue) 62%, var(--border))' : 'var(--border)'
                    }`,
                    borderRadius: 8,
                    color: 'var(--foreground)',
                    display: 'grid',
                    fontFamily: 'inherit',
                    fontSize: 13,
                    gap: 8,
                    gridTemplateColumns: '18px minmax(0, 1fr)',
                    lineHeight: 1.5,
                    minHeight: 36,
                    padding: '7px 9px',
                    textAlign: 'left',
                    width: '100%'
                  }}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    style={{
                      alignItems: 'center',
                      background: selected ? 'var(--accent-blue)' : 'transparent',
                      border: `1px solid ${selected ? 'var(--accent-blue)' : 'var(--muted-foreground)'}`,
                      borderRadius: multiple ? 4 : 999,
                      color: 'white',
                      display: 'inline-flex',
                      fontSize: 11,
                      height: 16,
                      justifyContent: 'center',
                      marginTop: 1,
                      width: 16
                    }}
                  >
                    {selected ? (multiple ? '✓' : '•') : null}
                  </span>
                  <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{option}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        {currentQuestion.allowOther ? (
          <label
            className="monad-ui-question-other"
            style={{
              alignItems: 'center',
              background:
                active === currentQuestion.options.length
                  ? 'color-mix(in srgb, var(--foreground) 5%, transparent)'
                  : 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 8,
              display: 'grid',
              gap: 8,
              gridTemplateColumns: '18px minmax(0, 1fr)',
              minHeight: 36,
              padding: '7px 9px'
            }}
          >
            <span
              data-other-option-marker="true"
              style={{
                alignItems: 'center',
                border: '1px solid var(--muted-foreground)',
                borderRadius: multiple ? 4 : 999,
                color: 'var(--muted-foreground)',
                display: 'inline-flex',
                fontFamily: 'var(--font-ui)',
                fontSize: 10,
                height: 16,
                justifyContent: 'center',
                width: 16
              }}
            >
              +
            </span>
            <input
              aria-label={otherAriaLabel}
              onChange={(event) => updateDraft((current) => ({ ...current, other: event.target.value }))}
              onFocus={() => setActive(currentQuestion.options.length)}
              placeholder={otherPlaceholder}
              ref={otherRef}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--foreground)',
                font: 'inherit',
                fontSize: 15,
                lineHeight: 1.4,
                minWidth: 0,
                outline: 'none',
                padding: 0,
                width: '100%'
              }}
              value={draft.other}
            />
          </label>
        ) : null}
      </div>
      <div style={{ alignItems: 'center', display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button
          className="workplace-action"
          onClick={dismiss}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--muted-foreground)',
            fontSize: 13,
            fontWeight: 650,
            height: 32,
            padding: '0 5px'
          }}
          type="button"
        >
          {dismissLabel} <span style={{ fontFamily: 'var(--font-ui)', opacity: 0.72 }}>ESC</span>
        </button>
        {questionIndex > 0 ? (
          <button
            className="workplace-action"
            onClick={() => {
              setActive(0);
              setQuestionIndex((index) => index - 1);
            }}
            style={{ fontSize: 13, height: 32, padding: '0 8px' }}
            type="button"
          >
            {backLabel}
          </button>
        ) : null}
        <button
          className="workplace-action"
          disabled={!canContinue}
          onClick={submit}
          style={{
            alignItems: 'center',
            background: 'var(--foreground)',
            border: 'none',
            borderRadius: 999,
            color: 'var(--background)',
            cursor: canContinue ? undefined : 'not-allowed',
            display: 'inline-flex',
            fontSize: 13,
            fontWeight: 760,
            gap: 6,
            height: 34,
            justifyContent: 'center',
            opacity: canContinue ? 1 : 0.42,
            padding: '0 14px'
          }}
          type="button"
        >
          {onLastQuestion ? submitLabel : nextLabel}
          <span style={{ fontFamily: 'var(--font-ui)' }}>↵</span>
        </button>
      </div>
    </fieldset>
  );
}
