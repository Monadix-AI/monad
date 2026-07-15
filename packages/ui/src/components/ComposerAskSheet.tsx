import type { ReactElement, ReactNode } from 'react';

import { useEffect, useMemo, useRef, useState } from 'react';

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
  dismissLabel: string;
  otherAriaLabel: string;
  otherPlaceholder: string;
  onAnswer: (requestId: string, answer: string) => void;
  onDismiss: (requestId: string) => void;
  position: number;
  question: ComposerAskSheetQuestion;
  submitLabel: string;
  total: number;
};

export function ComposerAskSheet({
  askedLabel,
  asker,
  buildAnswer,
  dismissLabel,
  onAnswer,
  onDismiss,
  otherAriaLabel,
  otherPlaceholder,
  position,
  question,
  submitLabel,
  total
}: ComposerAskSheetProps): ReactElement {
  const [selected, setSelected] = useState<string[]>([]);
  const [other, setOther] = useState('');
  const [active, setActive] = useState(0);
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLFieldSetElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);
  const multiple = question.mode === 'multiple';
  const focusableCount = question.options.length + (question.allowOther ? 1 : 0);
  const canSend = selected.length > 0 || other.trim().length > 0;
  const optionsByIndex = useMemo(() => new Map(question.options.map((option, index) => [index, option])), [question]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const choose = (option: string): void => {
    setSelected((current) => {
      if (multiple) return current.includes(option) ? current.filter((item) => item !== option) : [...current, option];
      return [option];
    });
  };

  const chooseIndex = (index: number): void => {
    const option = optionsByIndex.get(index);
    if (option) {
      choose(option);
      return;
    }
    if (question.allowOther && index === question.options.length) otherRef.current?.focus();
  };

  const complete = (callback: () => void): void => {
    setClosing(true);
    window.setTimeout(callback, closeMs);
  };

  const submit = (): void => {
    let answer = buildAnswer(selected, other, multiple);
    if (!answer && !multiple) {
      const option = optionsByIndex.get(active);
      if (option) answer = buildAnswer([option], other, multiple);
    }
    if (answer === null) return;
    complete(() => onAnswer(question.id, answer));
  };

  const dismiss = (): void => {
    complete(() => onDismiss(question.id));
  };

  return (
    <fieldset
      className={closing ? 'monad-ui-question-sheet is-closing' : 'monad-ui-question-sheet'}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.target instanceof HTMLInputElement) {
          if (event.key === 'Escape') {
            event.preventDefault();
            dismiss();
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
          return;
        }
        if (/^[1-9]$/.test(event.key)) {
          event.preventDefault();
          chooseIndex(Number(event.key) - 1);
          return;
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActive((index) => (focusableCount ? (index + 1) % focusableCount : 0));
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActive((index) => (focusableCount ? (index - 1 + focusableCount) % focusableCount : 0));
          return;
        }
        if (event.key === ' ') {
          event.preventDefault();
          chooseIndex(active);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          dismiss();
        }
      }}
      ref={panelRef}
      style={{
        background: 'color-mix(in srgb, var(--card) 92%, var(--background))',
        border: '1px solid color-mix(in srgb, var(--border) 86%, transparent)',
        borderRadius: 24,
        boxShadow: '0 18px 54px color-mix(in srgb, #000 14%, transparent)',
        display: 'grid',
        gap: 18,
        margin: '0 auto',
        maxHeight: 'min(52vh, 440px)',
        overflow: 'hidden',
        padding: '22px 26px 16px',
        width: 'min(100%, calc(100% - 28px))'
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
        {question.question}
      </legend>
      <style>{`
        .monad-ui-question-sheet {
          animation: monadUiQuestionIn 260ms cubic-bezier(.16,1.08,.36,1) both;
          transform-origin: bottom center;
        }
        .monad-ui-question-sheet.is-closing {
          animation: monadUiQuestionOut ${closeMs}ms cubic-bezier(.68,-.12,.36,1) both;
        }
        @keyframes monadUiQuestionIn {
          0% { opacity: 0; transform: translateY(28px) scale(.975); filter: blur(3px); }
          68% { opacity: 1; transform: translateY(-4px) scale(1.006); filter: blur(0); }
          100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
        }
        @keyframes monadUiQuestionOut {
          0% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
          100% { opacity: 0; transform: translateY(24px) scale(.982); filter: blur(2px); }
        }
      `}</style>
      <div style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
            {asker}
            <span style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>{askedLabel}</span>
          </div>
          {total > 1 ? (
            <span
              style={{
                border: '1px solid color-mix(in srgb, var(--border) 82%, transparent)',
                borderRadius: 999,
                color: 'var(--muted-foreground)',
                flex: 'none',
                fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, monospace',
                fontSize: 11,
                padding: '4px 8px'
              }}
            >
              {position}/{total}
            </span>
          ) : null}
        </div>
        <div style={{ fontSize: 18, fontWeight: 760, lineHeight: 1.35 }}>{question.question}</div>
      </div>
      <div style={{ display: 'grid', gap: 7, overflowY: 'auto', paddingRight: 2 }}>
        {question.options.map((option, index) => {
          const checked = selected.includes(option);
          const highlighted = active === index;
          return (
            <button
              aria-pressed={checked}
              className="workplace-action"
              key={option}
              onClick={() => choose(option)}
              onMouseEnter={() => setActive(index)}
              style={{
                alignItems: 'center',
                background: highlighted
                  ? 'color-mix(in srgb, var(--foreground) 7%, transparent)'
                  : checked
                    ? 'color-mix(in srgb, var(--accent-blue) 14%, transparent)'
                    : 'transparent',
                border: 'none',
                borderRadius: 14,
                color: 'var(--foreground)',
                display: 'grid',
                fontSize: 15,
                gap: 14,
                gridTemplateColumns: '34px minmax(0, 1fr)',
                minHeight: 48,
                padding: '7px 12px',
                textAlign: 'left'
              }}
              type="button"
            >
              <span
                style={{
                  alignItems: 'center',
                  background: checked ? 'var(--foreground)' : 'color-mix(in srgb, var(--foreground) 8%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--foreground) 14%, transparent)',
                  borderRadius: 999,
                  color: checked ? 'var(--background)' : 'var(--muted-foreground)',
                  display: 'inline-flex',
                  fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, monospace',
                  fontSize: 14,
                  fontWeight: 700,
                  height: 28,
                  justifyContent: 'center',
                  width: 28
                }}
              >
                {index + 1}
              </span>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{option}</span>
            </button>
          );
        })}
        {question.allowOther ? (
          <label
            style={{
              alignItems: 'center',
              background:
                active === question.options.length
                  ? 'color-mix(in srgb, var(--foreground) 7%, transparent)'
                  : 'transparent',
              borderRadius: 14,
              display: 'grid',
              gap: 14,
              gridTemplateColumns: '34px minmax(0, 1fr)',
              minHeight: 48,
              padding: '7px 12px'
            }}
          >
            <span
              style={{
                alignItems: 'center',
                border: '1px solid color-mix(in srgb, var(--foreground) 14%, transparent)',
                borderRadius: 999,
                color: 'var(--muted-foreground)',
                display: 'inline-flex',
                fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, monospace',
                fontSize: 15,
                height: 28,
                justifyContent: 'center',
                width: 28
              }}
            >
              ?
            </span>
            <input
              aria-label={otherAriaLabel}
              onChange={(event) => setOther(event.target.value)}
              onFocus={() => setActive(question.options.length)}
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
              value={other}
            />
          </label>
        ) : null}
      </div>
      <div style={{ alignItems: 'center', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button
          className="workplace-action"
          onClick={dismiss}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--muted-foreground)',
            fontSize: 14,
            fontWeight: 650,
            height: 36,
            padding: '0 6px'
          }}
          type="button"
        >
          {dismissLabel}{' '}
          <span style={{ fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, monospace', opacity: 0.72 }}>
            ESC
          </span>
        </button>
        <button
          className="workplace-action"
          disabled={!canSend}
          onClick={submit}
          style={{
            alignItems: 'center',
            background: 'var(--foreground)',
            border: 'none',
            borderRadius: 999,
            color: 'var(--background)',
            cursor: canSend ? 'pointer' : 'not-allowed',
            display: 'inline-flex',
            fontSize: 14,
            fontWeight: 760,
            gap: 8,
            height: 40,
            justifyContent: 'center',
            opacity: canSend ? 1 : 0.42,
            padding: '0 18px'
          }}
          type="button"
        >
          {submitLabel}
          <span style={{ fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, monospace' }}>↵</span>
        </button>
      </div>
    </fieldset>
  );
}
