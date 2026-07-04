'use client';

import type { ReactElement, ReactNode } from 'react';
import type { QuestionView } from '../../../project/types.ts';
import type { ProjectComposerSurface } from '../../utils/composer.ts';

import { ComposerSubmitButton, ComposerSurface, ComposerSwap, ComposerVoiceButton } from '@monad/ui';
import { workspaceMono as mono, workspaceSans as sans } from '@monad/ui/components/AgentAvatar';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useWorkspaceExperienceHost } from '../../../host-context.tsx';
import { workspaceExperienceT } from '../../../i18n.ts';
import { transcribeChatRoomAudio } from '../../composer-client.ts';
import {
  activeMention,
  createMentionChip,
  domPointAt,
  insertPlainText,
  renderSerializedEditor,
  serializeEditor,
  textBeforeCaret
} from '../../utils/composer-editor.ts';
import { ApprovalStack } from './approval-stack.tsx';
import { audioBlobToBase64 } from './audio.ts';
import { QuestionStack } from './question-stack.tsx';
import { useComposerVoice } from './use-composer-voice.ts';

export function Composer({ room }: { room: ProjectComposerSurface }): ReactElement {
  const host = useWorkspaceExperienceHost();
  const t = workspaceExperienceT();
  const [draft, setDraft] = useState('');
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [active, setActive] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [askPanelTestAnswered, setAskPanelTestAnswered] = useState(false);
  const [voiceCancelSignal, setVoiceCancelSignal] = useState(0);
  const editorRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const submittingTextRef = useRef<string | null>(null);
  const wasAskingRef = useRef(false);
  const askPanelTest =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('askPanelTest') === '1';

  const options = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return room.mentionTargets.filter((target) => target.name.toLowerCase().startsWith(q));
  }, [mention, room.mentionTargets]);
  const menuOpen = mention !== null && options.length > 0;
  const testQuestion: QuestionView | null =
    askPanelTest && !askPanelTestAnswered
      ? {
          id: 'clarify_preview',
          askerName: 'Lily',
          question: 'Which direction should I take for the next step?',
          options: ['Tighten the UI', 'Check the agent flow', 'Ship the current version'],
          mode: 'multiple',
          allowOther: true
        }
      : null;
  const questionQueue = testQuestion ? [...room.questions, testQuestion] : room.questions;
  const activeQuestion = questionQueue[0];
  const asking = questionQueue.length > 0;
  const questionAsker = activeQuestion
    ? room.participants.find((participant) => participant.name === activeQuestion.askerName)
    : undefined;
  const answerQuestion = (requestId: string, answer: string): void => {
    if (requestId === 'clarify_preview') {
      setAskPanelTestAnswered(true);
      editorRef.current?.focus();
      return;
    }
    room.answerQuestion(requestId, answer);
    editorRef.current?.focus();
  };
  const dismissQuestion = (requestId: string): void => {
    if (requestId === 'clarify_preview') {
      setAskPanelTestAnswered(true);
      editorRef.current?.focus();
      return;
    }
    room.answerQuestion(requestId, 'Dismissed without an answer.');
    editorRef.current?.focus();
  };

  useEffect(() => {
    if (asking && !wasAskingRef.current) setVoiceCancelSignal((value) => value + 1);
    wasAskingRef.current = asking;
  }, [asking]);

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
      <ApprovalStack room={room} />

      <ComposerSwap
        ask={
          activeQuestion ? (
            <QuestionStack
              asker={questionAsker}
              key={activeQuestion.id}
              onAnswer={answerQuestion}
              onDismiss={dismissQuestion}
              position={1}
              question={activeQuestion}
              total={questionQueue.length}
            />
          ) : null
        }
        asking={asking}
        composer={
          <ChatRoomComposerShell
            ariaLabel="Message agents"
            busy={Boolean(room.typing)}
            disabled={submitting}
            editorSlot={
              // biome-ignore lint/a11y/useSemanticElements: contenteditable is required for inline atomic mention chips.
              <div
                aria-label={t('web.workplace.messageAgents')}
                aria-multiline
                className="max-h-40 min-h-16 overflow-y-auto px-4 pt-3.5 pb-2 text-[15px] leading-relaxed outline-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]"
                contentEditable={!submitting}
                data-placeholder={t('web.workplace.composerPlaceholder')}
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
                    {t('web.workplace.chooseAgent')}
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
            placeholder={t('web.workplace.composerPlaceholder')}
            value={draft}
            voice={{
              modelCheckPending: host.voiceModelState === 'checking',
              modelConfigured: host.voiceModelState === 'configured',
              modelCheckFailed: host.voiceModelState === 'failed',
              onSettingsClick: () => host.openStudio('models'),
              transcribeAudio: async (audio) => {
                const body = await audioBlobToBase64(audio);
                return (await transcribeChatRoomAudio(host.fetch, body)).text;
              }
            }}
            voiceCancelSignal={voiceCancelSignal}
          />
        }
      />
    </div>
  );
}

function ChatRoomComposerShell({
  ariaLabel,
  busy = false,
  disabled = false,
  editorSlot,
  mentionMenu,
  onStop,
  onSubmit,
  onVoiceText,
  placeholder,
  value,
  voice,
  voiceCancelSignal
}: {
  ariaLabel: string;
  busy?: boolean;
  disabled?: boolean;
  editorSlot: ReactNode;
  mentionMenu?: ReactNode;
  onStop?: () => void;
  onSubmit: () => void;
  onVoiceText?: (text: string) => void;
  placeholder: string;
  value: string;
  voice?: {
    modelCheckFailed?: boolean;
    modelCheckPending?: boolean;
    modelConfigured?: boolean;
    onSettingsClick?: () => void;
    transcribeAudio?: (audio: Blob) => Promise<string>;
  };
  voiceCancelSignal?: number;
}): ReactElement {
  const { listening, toggleVoice, voiceActive, voiceBusy, voiceDisabledReason, voiceModelConfigured } =
    useComposerVoice({
      cancelSignal: voiceCancelSignal,
      onVoiceText,
      voice
    });
  const canSend = value.trim().length > 0 && !disabled && !voiceActive;
  const canStop = busy && onStop;
  const submitDisabled = !canSend && !canStop;
  const voiceChecking = Boolean(voice?.modelCheckPending && !listening);
  const voiceCheckFailed = Boolean(voice?.modelCheckFailed && !listening);
  const effectiveVoiceDisabledReason = voiceChecking
    ? 'Checking voice model settings.'
    : voiceCheckFailed
      ? 'Could not check voice model settings.'
      : voiceDisabledReason;
  const voiceUnavailable = Boolean(effectiveVoiceDisabledReason && !listening && !voiceBusy);
  const voiceTitle = voiceChecking
    ? 'Checking voice model settings'
    : voiceCheckFailed
      ? 'Could not check voice model settings'
      : voiceBusy
        ? 'Cleaning up transcript'
        : listening
          ? 'Recording voice input'
          : effectiveVoiceDisabledReason
            ? effectiveVoiceDisabledReason
            : 'Voice input';

  return (
    <ComposerSurface
      ariaBusy={voiceActive}
      busyTitle={voiceTitle}
      mentionMenu={mentionMenu}
      rightTools={
        <>
          <span
            aria-live="polite"
            className="sr-only"
          >
            {placeholder}
          </span>
          <ComposerVoiceButton
            ariaDisabled={voiceUnavailable}
            ariaLabel={voiceTitle}
            disabled={!onVoiceText}
            onClick={() => {
              if (voiceUnavailable && !voiceModelConfigured && !voiceChecking && !voiceCheckFailed) {
                voice?.onSettingsClick?.();
                return;
              }
              void toggleVoice();
            }}
            state={voiceBusy || voiceChecking ? 'busy' : listening ? 'listening' : 'idle'}
            title={voiceTitle}
          />
          <ComposerSubmitButton
            ariaLabel={canStop ? 'Stop' : ariaLabel}
            canSend={canSend}
            canStop={Boolean(canStop)}
            disabled={submitDisabled}
            onClick={canStop ? onStop : onSubmit}
          />
        </>
      }
    >
      {editorSlot}
      {listening ? <VoiceRecordingStatus /> : voiceBusy ? <VoiceTranscriptStatus /> : null}
    </ComposerSurface>
  );
}

function VoiceStatusShell({ children }: { children: ReactNode }): ReactElement {
  return (
    <div
      aria-live="polite"
      className="px-4 pb-2"
      style={{ color: 'var(--muted-foreground)' }}
    >
      <div
        style={{
          alignItems: 'center',
          display: 'inline-flex',
          gap: 8,
          fontSize: 12,
          lineHeight: 1.2
        }}
      >
        {children}
      </div>
    </div>
  );
}

function VoiceRecordingStatus(): ReactElement {
  return (
    <VoiceStatusShell>
      <style>{`
        @keyframes monadChatroomRecordingWave {
          0%, 100% { transform: scaleY(.38); opacity: .45; }
          45% { transform: scaleY(1); opacity: 1; }
        }
        @keyframes monadChatroomRecordingRing {
          0% { opacity: .38; transform: scale(.78); }
          70%, 100% { opacity: 0; transform: scale(1.34); }
        }
      `}</style>
      <svg
        aria-hidden="true"
        height="32"
        viewBox="0 0 72 36"
        width="64"
      >
        <g
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
        >
          <circle
            cx="17"
            cy="18"
            r="8"
            style={{ animation: 'monadChatroomRecordingRing 1.4s ease-out infinite', transformOrigin: '17px 18px' }}
          />
          <path d="M17 10v11" />
          <path d="M12.5 21a4.5 4.5 0 0 0 9 0" />
          <path d="M17 25v4" />
          <path d="M13 29h8" />
          {[34, 42, 50, 58].map((x, index) => (
            <path
              d={`M${x} 13v10`}
              key={x}
              style={{
                animation: 'monadChatroomRecordingWave .86s ease-in-out infinite',
                animationDelay: `${index * 110}ms`,
                transformBox: 'fill-box',
                transformOrigin: 'center'
              }}
            />
          ))}
        </g>
      </svg>
      <span>Recording audio...</span>
    </VoiceStatusShell>
  );
}

function VoiceTranscriptStatus(): ReactElement {
  return (
    <VoiceStatusShell>
      <style>{`
        @keyframes monadChatroomScribeHand {
          0%, 100% { transform: rotate(-7deg) translateX(0); }
          50% { transform: rotate(3deg) translateX(4px); }
        }
        @keyframes monadChatroomScribeLine {
          0% { stroke-dashoffset: 42; opacity: .28; }
          45%, 100% { stroke-dashoffset: 0; opacity: .9; }
        }
        @keyframes monadChatroomScribeHead {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(1px); }
        }
      `}</style>
      <svg
        aria-hidden="true"
        height="32"
        viewBox="0 0 72 36"
        width="64"
      >
        <g
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
        >
          <g style={{ animation: 'monadChatroomScribeHead 1.4s ease-in-out infinite' }}>
            <circle
              cx="17"
              cy="9"
              r="5"
            />
            <path d="M10.5 22c1.3-6.6 11.7-6.6 13 0" />
          </g>
          <path
            d="M35 11h25"
            opacity=".28"
          />
          <path
            d="M35 18h29"
            opacity=".28"
          />
          <path
            d="M35 25h22"
            opacity=".28"
          />
          {[11, 18, 25].map((y, index) => (
            <path
              d={index === 2 ? 'M35 25h22' : index === 1 ? 'M35 18h29' : 'M35 11h25'}
              key={y}
              style={{
                animation: 'monadChatroomScribeLine 1.8s ease-in-out infinite',
                animationDelay: `${index * 220}ms`,
                strokeDasharray: 42,
                strokeDashoffset: 42
              }}
            />
          ))}
          <g
            style={{
              animation: 'monadChatroomScribeHand .72s ease-in-out infinite',
              transformBox: 'fill-box',
              transformOrigin: '18px 22px'
            }}
          >
            <path d="M20 20l9 5" />
            <path d="M28 25l4 1.8" />
          </g>
        </g>
      </svg>
      <span>Generating transcript...</span>
    </VoiceStatusShell>
  );
}
