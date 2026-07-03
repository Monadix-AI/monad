import type { UseHotkeyDefinition } from '@tanstack/react-hotkeys';
import type { Participant, QuestionView } from './types';

import { ProductIcon } from '@monad/ui';
import { useHotkeys } from '@tanstack/react-hotkeys';
import { useEffect, useRef, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { AgentIdentity, AgentInstanceAvatar, ghostButtonStyle, inkButtonStyle, resolveProductIcon } from './Bits';
import { buildClarifyAnswer } from './clarify-answer';
import { boxR, mono, sans } from './styles';

export function QuestionStack({
  asker,
  onAnswer,
  question
}: {
  asker?: Pick<Participant, 'av' | 'avatarUrl' | 'icon' | 'name'>;
  onAnswer: (requestId: string, answer: string) => void;
  question: QuestionView;
}): React.ReactElement {
  const t = useT();
  const [selected, setSelected] = useState<string[]>([]);
  const [other, setOther] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const otherRef = useRef<HTMLTextAreaElement>(null);
  const multiple = question.mode === 'multiple';
  const canSend = selected.length > 0 || other.trim().length > 0;
  const displayAgent = asker ?? {
    av: question.askerName.slice(0, 2).toUpperCase(),
    name: question.askerName
  };
  const productIcon = resolveProductIcon(displayAgent);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const toggle = (option: string): void => {
    setSelected((current) =>
      multiple
        ? current.includes(option)
          ? current.filter((item) => item !== option)
          : [...current, option]
        : [option]
    );
  };
  const skip = (): void => {
    onAnswer(question.id, '');
    setSelected([]);
    setOther('');
  };
  const submit = (): void => {
    const answer = buildClarifyAnswer(selected, other, multiple);
    if (answer === null) return;
    onAnswer(question.id, answer);
    setSelected([]);
    setOther('');
  };
  const chooseShortcut = (index: number): void => {
    const option = question.options[index - 1];
    if (option) {
      toggle(option);
      return;
    }
    if (question.allowOther && index === question.options.length + 1) otherRef.current?.focus();
  };
  const hotkeys: UseHotkeyDefinition[] = [
    ...Array.from({ length: Math.min(9, question.options.length + (question.allowOther ? 1 : 0)) }, (_, index) => ({
      hotkey: String(index + 1) as UseHotkeyDefinition['hotkey'],
      callback: () => chooseShortcut(index + 1)
    })),
    {
      hotkey: 'Enter' as UseHotkeyDefinition['hotkey'],
      callback: () => submit()
    },
    {
      hotkey: 'Escape' as UseHotkeyDefinition['hotkey'],
      callback: () => panelRef.current?.blur()
    }
  ];
  useHotkeys(hotkeys, {
    target: panelRef,
    ignoreInputs: true,
    preventDefault: true,
    stopPropagation: true,
    requireReset: true
  });
  return (
    <div
      ref={panelRef}
      style={{
        display: 'grid',
        gap: 8,
        outline: 'none',
        transformOrigin: 'top center'
      }}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the question attachment is a scoped hotkey target.
      tabIndex={0}
    >
      <div
        style={{
          border: '1px solid color-mix(in srgb, var(--accent-blue) 46%, var(--border))',
          borderRadius: boxR,
          background: 'color-mix(in srgb, var(--accent-blue) 10%, var(--card))',
          padding: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 9
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <AgentInstanceAvatar
            agent={displayAgent}
            size={26}
          />
          <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 7, fontFamily: sans }}>
            <AgentIdentity
              badge={
                productIcon ? (
                  <ProductIcon
                    product={productIcon}
                    size={13}
                    title={displayAgent.name}
                  />
                ) : null
              }
              badgeGap={6}
              name={displayAgent.name}
              nameStyle={{ fontSize: 14, fontWeight: 700 }}
            />
            <span style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>{t('web.workplace.askedQuestion')}</span>
          </div>
        </div>
        <div style={{ fontFamily: sans, fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap', paddingLeft: 35 }}>
          {question.question}
        </div>
        {question.options.length > 0 ? (
          <div style={{ display: 'grid', gap: 6, paddingLeft: 35 }}>
            {question.options.map((option, index) => {
              const active = selected.includes(option);
              const number = index + 1;
              return (
                <button
                  className="workplace-action"
                  key={option}
                  onClick={() => toggle(option)}
                  style={{
                    width: '100%',
                    minHeight: 34,
                    borderRadius: 9,
                    border: `1px solid ${active ? 'var(--accent-blue)' : 'color-mix(in srgb, var(--border) 82%, transparent)'}`,
                    background: active ? 'color-mix(in srgb, var(--accent-blue) 18%, var(--card))' : 'var(--card)',
                    color: 'var(--foreground)',
                    fontFamily: sans,
                    fontSize: 13,
                    padding: '6px 9px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    textAlign: 'left'
                  }}
                  type="button"
                >
                  {multiple ? (
                    <span
                      aria-hidden="true"
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 4,
                        border: `1px solid ${active ? 'var(--accent-blue)' : 'var(--border)'}`,
                        background: active ? 'var(--accent-blue)' : 'transparent',
                        color: 'var(--primary-foreground)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontFamily: mono,
                        fontSize: 10,
                        lineHeight: 1,
                        flex: 'none'
                      }}
                    >
                      {active ? 'x' : ''}
                    </span>
                  ) : null}
                  <span
                    style={{
                      flex: 'none',
                      minWidth: 21,
                      height: 21,
                      borderRadius: 999,
                      border: '1px solid var(--border)',
                      color: 'var(--muted-foreground)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontFamily: mono,
                      fontSize: 11
                    }}
                  >
                    {number}
                  </span>
                  <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{option}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        {question.allowOther ? (
          <div style={{ display: 'grid', gap: 6, paddingLeft: 35 }}>
            <div
              style={{
                minHeight: 34,
                borderRadius: 9,
                border: '1px solid color-mix(in srgb, var(--border) 82%, transparent)',
                background: 'var(--card)',
                padding: '6px 9px',
                display: 'flex',
                alignItems: 'center',
                gap: 9
              }}
            >
              <span
                style={{
                  flex: 'none',
                  minWidth: 21,
                  height: 21,
                  borderRadius: 999,
                  border: '1px solid var(--border)',
                  color: 'var(--muted-foreground)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: mono,
                  fontSize: 11
                }}
              >
                {question.options.length + 1}
              </span>
              <textarea
                aria-label={t('web.workplace.otherAnswer')}
                onChange={(event) => setOther(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder={t('web.workplace.otherPlaceholder')}
                ref={otherRef}
                rows={1}
                style={{
                  width: '100%',
                  resize: 'none',
                  minHeight: 22,
                  maxHeight: 70,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--foreground)',
                  fontFamily: sans,
                  fontSize: 13,
                  lineHeight: 1.45,
                  padding: 0,
                  outline: 'none'
                }}
                value={other}
              />
            </div>
          </div>
        ) : null}
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingLeft: 35 }}
        >
          <span style={{ alignSelf: 'center', color: 'var(--muted-foreground)', fontFamily: mono, fontSize: 11 }}>
            {multiple ? 'Numbers toggle choices' : 'Numbers choose one'}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <button
              className="workplace-action"
              onClick={skip}
              style={ghostButtonStyle({ height: 32, padding: '0 13px' })}
              type="button"
            >
              Skip
            </button>
            <button
              className="workplace-action"
              disabled={!canSend}
              onClick={submit}
              style={
                canSend
                  ? inkButtonStyle({ height: 32, padding: '0 14px' })
                  : ghostButtonStyle({ height: 32, opacity: 0.55, padding: '0 14px' })
              }
              type="button"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
