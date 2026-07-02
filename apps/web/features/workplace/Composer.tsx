import type { UseHotkeyDefinition } from '@tanstack/react-hotkeys';
import type { Participant, QuestionView } from './types';
import type { ProjectController } from './use-project';

import {
  profileSelectors,
  useGetRolesQuery,
  useListProfilesQuery,
  useTranscribeAudioMutation
} from '@monad/client-rtk';
import { ProductIcon } from '@monad/ui';
import { useHotkeys } from '@tanstack/react-hotkeys';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import { mentionToken, parseMentionTokens } from '@/components/MentionText';
import { studioPath } from '@/features/routes/route-paths';
import { ComposerShell } from '@/features/session/ComposerShell';
import { audioBlobToBase64 } from '@/features/session/voice-transcription';
import { ApprovalStack } from './activity/ApprovalStack';
import { AgentIdentity, AgentInstanceAvatar, ghostButtonStyle, inkButtonStyle, resolveProductIcon } from './Bits';
import { boxR, mono, sans } from './styles';

function activeMention(value: string, caret: number): { query: string; start: number } | null {
  const before = value.slice(0, caret);
  const m = before.match(/(?:^|\s)@([\w.-]*)$/);
  if (!m) return null;
  return { query: m[1], start: caret - m[1].length - 1 };
}

function createMentionChip(target: { id: string; name: string }): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.contentEditable = 'false';
  chip.dataset.mentionId = target.id;
  chip.dataset.mentionName = target.name;
  chip.className = 'mx-1 inline-flex max-w-full items-center rounded bg-accent-blue px-1 align-baseline text-white';
  chip.title = target.id;
  chip.textContent = `@${target.name}`;
  return chip;
}

function serializeEditor(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof HTMLBRElement) return '\n';
  if (node instanceof HTMLElement && node.dataset.mentionId && node.dataset.mentionName) {
    return mentionToken({ id: node.dataset.mentionId, name: node.dataset.mentionName });
  }
  return [...node.childNodes].map(serializeEditor).join('');
}

function renderSerializedEditor(root: HTMLElement, text: string): void {
  root.textContent = '';
  let cursor = 0;
  for (const token of parseMentionTokens(text)) {
    if (token.start > cursor) root.append(document.createTextNode(text.slice(cursor, token.start)));
    root.append(createMentionChip(token));
    cursor = token.end;
  }
  if (cursor < text.length) root.append(document.createTextNode(text.slice(cursor)));
}

function textLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').length;
  if (node instanceof HTMLElement && node.dataset.mentionName) return node.textContent?.length ?? 0;
  return [...node.childNodes].reduce((sum, child) => sum + textLength(child), 0);
}

function domPointAt(root: Node, offset: number): { node: Node; offset: number } {
  let remaining = offset;
  for (const child of [...root.childNodes]) {
    const len = textLength(child);
    if (remaining > len) {
      remaining -= len;
      continue;
    }
    if (child.nodeType === Node.TEXT_NODE) return { node: child, offset: Math.min(remaining, len) };
    if (child instanceof HTMLElement && child.dataset.mentionName) {
      const index = [...root.childNodes].indexOf(child);
      return { node: root, offset: remaining <= 0 ? index : index + 1 };
    }
    return domPointAt(child, remaining);
  }
  return { node: root, offset: root.childNodes.length };
}

function textBeforeCaret(root: HTMLElement): string {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return '';
  const range = selection.getRangeAt(0);
  const before = range.cloneRange();
  before.selectNodeContents(root);
  before.setEnd(range.endContainer, range.endOffset);
  return before.toString();
}

function insertPlainText(text: string): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function QuestionStack({
  asker,
  onAnswer,
  question
}: {
  asker?: Pick<Participant, 'av' | 'avatarUrl' | 'icon' | 'name'>;
  onAnswer: (requestId: string, answer: string) => void;
  question: QuestionView;
}): React.ReactElement {
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
    if (!multiple) setOther('');
  };
  const skip = (): void => {
    onAnswer(question.id, '');
    setSelected([]);
    setOther('');
  };
  const submit = (): void => {
    const values = [...selected, ...(other.trim() ? [other.trim()] : [])];
    if (values.length === 0) return;
    onAnswer(question.id, multiple ? JSON.stringify(values) : (values[0] ?? ''));
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
            <span style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>asked you a question</span>
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
                aria-label="Other answer"
                onChange={(event) => {
                  setOther(event.target.value);
                  if (!multiple && event.target.value.trim()) setSelected([]);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder="Other…"
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

export function Composer({ room }: { room: ProjectController }): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: modelRoles } = useGetRolesQuery(undefined);
  const { data: profileData } = useListProfilesQuery(undefined);
  const profiles = profileData ? profileSelectors.selectAll(profileData.profiles) : [];
  const defaultProfile = profiles.find((profile) => profile.alias === profileData?.defaultAlias);
  const [transcribeAudio] = useTranscribeAudioMutation();
  const [draft, setDraft] = useState('');
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [active, setActive] = useState(0);
  const [accessMode, setAccessMode] = useState<'auto' | 'ask'>('auto');
  const [submitting, setSubmitting] = useState(false);
  const [askPanelTestAnswered, setAskPanelTestAnswered] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const submittingTextRef = useRef<string | null>(null);

  const options = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return room.mentionTargets.filter((target) => target.name.toLowerCase().startsWith(q));
  }, [mention, room.mentionTargets]);
  const menuOpen = mention !== null && options.length > 0;
  const testQuestion: QuestionView | null =
    searchParams.get('askPanelTest') === '1' && !askPanelTestAnswered
      ? {
          id: 'clarify_preview',
          askerName: 'Lily',
          question: 'Which direction should I take for the next step?',
          options: ['Tighten the UI', 'Check the agent flow', 'Ship the current version'],
          mode: 'multiple',
          allowOther: true
        }
      : null;
  const activeQuestion = room.questions[0] ?? testQuestion;
  const questionAsker = activeQuestion
    ? room.participants.find((participant) => participant.name === activeQuestion.askerName)
    : undefined;
  const answerQuestion = (requestId: string, answer: string): void => {
    if (requestId === 'clarify_preview') {
      setAskPanelTestAnswered(true);
      return;
    }
    room.answerQuestion(requestId, answer);
  };

  const syncMention = (value: string, caret: number): void => {
    const m = activeMention(value, caret);
    if (!mention || !m || mention.start !== m.start) setActive(0);
    setMention(m);
  };

  const syncFromEditor = (): void => {
    const editor = editorRef.current;
    if (!editor) return;
    setDraft(serializeEditor(editor));
    syncMention(textBeforeCaret(editor), textBeforeCaret(editor).length);
  };

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text) return;
    if (sendingRef.current) return;
    if (submittingTextRef.current === text) return;
    sendingRef.current = true;
    submittingTextRef.current = text;
    setSubmitting(true);
    setDraft('');
    setMention(null);
    if (editorRef.current) editorRef.current.textContent = '';
    try {
      await room.sendDirective(text);
    } catch {
      setDraft((current) => (current ? current : text));
      if (editorRef.current) renderSerializedEditor(editorRef.current, text);
    } finally {
      submittingTextRef.current = null;
      sendingRef.current = false;
      setSubmitting(false);
      editorRef.current?.focus();
    }
  };

  const acceptMention = (target: { id: string; name: string }): void => {
    if (!mention) return;
    const editor = editorRef.current;
    if (!editor) return;
    const before = textBeforeCaret(editor);
    const start = mention.start;
    const end = before.length;
    const range = document.createRange();
    const from = domPointAt(editor, start);
    const to = domPointAt(editor, end);
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    range.deleteContents();
    const space = document.createTextNode(' ');
    range.insertNode(space);
    range.insertNode(createMentionChip(target));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    const caret = document.createRange();
    caret.setStartAfter(space);
    caret.collapse(true);
    selection?.addRange(caret);
    setDraft(serializeEditor(editor));
    setMention(null);
  };

  return (
    <div
      style={{
        flex: 'none',
        position: 'relative'
      }}
    >
      {activeQuestion ? (
        <div
          style={{
            position: 'absolute',
            left: 16,
            right: 16,
            bottom: '100%',
            marginBottom: 8,
            zIndex: 20,
            maxHeight: 'min(52vh, 420px)',
            overflowY: 'auto'
          }}
        >
          <QuestionStack
            asker={questionAsker}
            key={activeQuestion.id}
            onAnswer={answerQuestion}
            question={activeQuestion}
          />
        </div>
      ) : null}
      <ApprovalStack room={room} />

      <div style={{ padding: '14px 16px 18px' }}>
        <ComposerShell
          access={{
            mode: accessMode,
            onChange: setAccessMode
          }}
          ariaLabel="Message agents"
          busy={Boolean(room.typing)}
          contextUsage={
            room.contextUsage
              ? {
                  approximate: room.contextUsage.approximate,
                  limit: room.contextUsage.contextLimit,
                  segments: room.contextUsage.segments,
                  used: room.contextUsage.used
                }
              : undefined
          }
          controls={{ access: false, context: false, model: false, submit: true, voice: true }}
          disabled={submitting}
          editorSlot={
            // biome-ignore lint/a11y/useSemanticElements: contenteditable is required for inline atomic mention chips.
            <div
              aria-label="Message agents"
              aria-multiline
              className="max-h-40 min-h-16 overflow-y-auto px-4 pt-3.5 pb-2 text-[15px] leading-relaxed outline-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]"
              contentEditable={!submitting}
              data-placeholder="Ask for follow-up changes"
              onBlur={() => setMention(null)}
              onDrop={(e) => {
                e.preventDefault();
                const text = e.dataTransfer.getData('text/plain');
                if (text) insertPlainText(text);
                syncFromEditor();
              }}
              onInput={syncFromEditor}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (menuOpen) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActive((i) => (i + 1) % options.length);
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActive((i) => (i - 1 + options.length) % options.length);
                    return;
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    const target = options[active];
                    if (target) acceptMention(target);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setMention(null);
                    return;
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              onKeyUp={() => syncFromEditor()}
              onPaste={(e) => {
                e.preventDefault();
                insertPlainText(e.clipboardData.getData('text/plain'));
                syncFromEditor();
              }}
              ref={editorRef}
              role="textbox"
              suppressContentEditableWarning
              tabIndex={0}
            />
          }
          mentionMenu={
            menuOpen ? (
              <div
                className="glass-surface"
                style={{
                  position: 'absolute',
                  left: 18,
                  bottom: 10,
                  minWidth: 180,
                  overflow: 'hidden',
                  zIndex: 60
                }}
              >
                <div
                  style={{
                    fontFamily: mono,
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: 1,
                    color: 'var(--muted-foreground)',
                    padding: '6px 10px 2px'
                  }}
                >
                  Choose an agent
                </div>
                {options.map((target, i) => (
                  <button
                    className="workplace-action"
                    key={target.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptMention(target);
                    }}
                    onMouseEnter={() => setActive(i)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      border: 'none',
                      fontFamily: sans,
                      fontSize: 14,
                      fontWeight: 500,
                      padding: '6px 10px',
                      color: i === active ? 'var(--accent-foreground)' : 'var(--foreground)',
                      background:
                        i === active ? 'color-mix(in srgb, var(--accent-blue) 30%, var(--card))' : 'transparent'
                    }}
                    type="button"
                  >
                    @{target.name}
                  </button>
                ))}
              </div>
            ) : null
          }
          model={{
            current: room.modelProfiles[0]?.alias,
            onChange: (alias) => {
              if (!alias) return;
              room.sendDirective(`/model ${alias}`);
            },
            options: room.modelProfiles.map((profile) => ({ label: profile.alias, value: profile.alias }))
          }}
          onStop={room.pauseAll}
          onSubmit={submit}
          onVoiceText={(text) => {
            const editor = editorRef.current;
            if (editor) {
              editor.append(document.createTextNode(`${editor.textContent?.trim() ? ' ' : ''}${text}`));
              setDraft(serializeEditor(editor));
            }
            setMention(null);
          }}
          placeholder="Ask for follow-up changes"
          value={draft}
          voice={{
            modelConfigured: Boolean(
              modelRoles?.transcription && defaultProfile?.routes.chat.provider && defaultProfile.routes.chat.modelId
            ),
            onSettingsClick: () => router.push(studioPath('models')),
            transcribeAudio: async (audio) => {
              const body = await audioBlobToBase64(audio);
              return (await transcribeAudio(body).unwrap()).text;
            }
          }}
        />
      </div>
    </div>
  );
}
