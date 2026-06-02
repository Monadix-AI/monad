import type { ComposerEditorHandle } from '@monad/ui';
import type { ReactElement, ReactNode } from 'react';
import type { QuestionView } from '../../../experience/types.ts';
import type { ProjectComposerSurface } from '../../utils/composer.ts';

import { Attachment01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  draftAttachmentBase64,
  fileToDraftAttachment,
  pastedTextDraftAttachment,
  sendableDraftAttachments,
  useOpenDraftAttachmentMutation,
  useTranscribeAudioMutation
} from '@monad/sdk-experience/react';
import {
  ComposerEditor,
  ComposerIconButton,
  ComposerSubmitButton,
  ComposerSwap,
  ComposerVoiceButton,
  UnifiedComposer
} from '@monad/ui';
import { workspaceMono as mono, workspaceSans as sans } from '@monad/ui/components/AgentAvatar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useWorkplaceExperienceHost } from '../../../host-context.tsx';
import { workplaceExperienceT } from '../../../i18n.ts';
import { ApprovalStack } from './approval-stack.tsx';
import {
  AttachmentPreviewStrip,
  attachmentMediaType,
  type ComposerDroppedFiles,
  type DraftAttachment
} from './attachments.tsx';
import { audioBlobToBase64 } from './audio.ts';
import { QuestionStack } from './question-stack.tsx';
import { ReplyDraft } from './reply-draft.tsx';
import { type ProjectComposerSubmission, projectComposerSubmission } from './submission.ts';
import { useComposerVoice } from './use-composer-voice.ts';

export type { ComposerDroppedFiles } from './attachments.tsx';

const COMPOSER_DRAFT_STORAGE_PREFIX = 'monad:chat-room-composer-draft:';
const LONG_PASTE_TEXT_THRESHOLD = 1000;

function readComposerDraft(key: string): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(`${COMPOSER_DRAFT_STORAGE_PREFIX}${key}`) ?? '';
  } catch {
    return '';
  }
}

function writeComposerDraft(key: string, draft: string): void {
  const storageKey = `${COMPOSER_DRAFT_STORAGE_PREFIX}${key}`;
  if (draft.trim()) {
    try {
      window.localStorage.setItem(storageKey, draft);
    } catch {
      // Draft cache is best-effort; typing must keep working if storage is unavailable.
    }
    return;
  }
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Ignore storage cleanup failures.
  }
}

export function Composer({
  droppedFiles,
  room
}: {
  droppedFiles?: ComposerDroppedFiles;
  room: ProjectComposerSurface;
}): ReactElement {
  const host = useWorkplaceExperienceHost();
  const t = workplaceExperienceT();
  const [openDraftAttachment] = useOpenDraftAttachmentMutation();
  const [transcribeAudio] = useTranscribeAudioMutation();
  const [draft, setDraft] = useState(() => readComposerDraft(room.draftKey));
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionMenuPosition, setMentionMenuPosition] = useState<{ bottom: number; left: number } | null>(null);
  const [active, setActive] = useState(0);
  const [askPanelTestAnswered, setAskPanelTestAnswered] = useState(false);
  const [voiceCancelSignal, setVoiceCancelSignal] = useState(0);
  const editorRef = useRef<ComposerEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftKeyRef = useRef(room.draftKey);
  const wasAwaitingDecisionRef = useRef(false);
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
  const activeApproval = room.approvals[0];
  const awaitingDecision = Boolean(activeApproval || activeQuestion);
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
    room.answerQuestion(requestId, '');
    editorRef.current?.focus();
  };

  useEffect(() => {
    if (awaitingDecision && !wasAwaitingDecisionRef.current) setVoiceCancelSignal((value) => value + 1);
    wasAwaitingDecisionRef.current = awaitingDecision;
  }, [awaitingDecision]);

  useEffect(() => {
    draftKeyRef.current = room.draftKey;
    const nextDraft = readComposerDraft(room.draftKey);
    setDraft(nextDraft);
    setMention(null);
    setMentionMenuPosition(null);
  }, [room.draftKey]);

  const updateDraft = (nextDraft: string): void => {
    setDraft(nextDraft);
    writeComposerDraft(draftKeyRef.current, nextDraft);
  };

  const addAttachments = useCallback(async (files: File[] | FileList): Promise<void> => {
    const next = await Promise.all([...files].map(fileToDraftAttachment));
    if (next.length) setAttachments((current) => [...current, ...next]);
  }, []);

  useEffect(() => {
    if (!droppedFiles?.files.length) return;
    void addAttachments(droppedFiles.files);
  }, [addAttachments, droppedFiles]);

  const removeAttachment = (index: number): void => {
    setAttachments((current) => current.filter((_, i) => i !== index));
  };

  const openAttachment = async (attachment: DraftAttachment): Promise<void> => {
    const dataBase64 = await draftAttachmentBase64(attachment);
    if (!dataBase64) return;
    await openDraftAttachment({
      dataBase64,
      mediaType: attachmentMediaType(attachment) || undefined,
      name: attachment.localFile?.name ?? attachment.name
    }).unwrap();
  };

  const sendNow = useCallback(
    (item: ProjectComposerSubmission): void => {
      const text = item.text.trim();
      if (!text && item.attachments.length === 0) return;
      void Promise.resolve(
        room.sendDirective({
          attachments: item.attachments,
          replyGeneration: item.replyGeneration,
          replyToMessageId: item.replyToMessageId,
          text
        })
      ).catch(() => {});
    },
    [room]
  );

  const submit = (): void => {
    const text = draft.trim();
    const nextAttachments = sendableDraftAttachments(attachments);
    if (room.replyTarget === null) return;
    const submission = projectComposerSubmission({
      attachments: nextAttachments,
      replyToMessageId: room.replyToMessageId,
      replyGeneration: room.replyGeneration,
      text
    });
    if (!submission) return;
    updateDraft('');
    setMention(null);
    editorRef.current?.clear();
    sendNow(submission);
    setAttachments([]);
    editorRef.current?.focus();
  };

  const acceptMention = (target: { id: string; name: string }): void => {
    if (!mention) return;
    editorRef.current?.insertMention(target);
    setMention(null);
    setMentionMenuPosition(null);
  };

  return (
    <div
      style={{
        flex: 'none',
        position: 'relative'
      }}
    >
      <ComposerSwap
        ask={
          activeApproval ? (
            <ApprovalStack
              key={activeApproval.id}
              room={room}
            />
          ) : activeQuestion ? (
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
        asking={awaitingDecision}
        composer={
          <ChatRoomComposerShell
            ariaLabel="Message agents"
            busy={Boolean(room.typing)}
            disabled={room.replyTarget === null}
            editorSlot={
              <>
                {room.replyTarget !== undefined ? (
                  <ReplyDraft
                    cancelLabel={t('web.chat.cancelReply')}
                    onCancel={() => room.cancelReply?.()}
                    onOpen={room.replyTarget ? () => room.openReplyTarget?.() : undefined}
                    replyingToLabel={
                      room.replyTarget
                        ? t('web.chat.replyingTo', { author: room.replyTarget.authorName })
                        : t('web.chat.replyUnavailable')
                    }
                    target={room.replyTarget}
                    unavailableLabel={t('web.chat.replyUnavailable')}
                  />
                ) : null}
                {attachments.length ? (
                  <AttachmentPreviewStrip
                    attachments={attachments}
                    onOpen={(attachment) => void openAttachment(attachment)}
                    onRemove={removeAttachment}
                  />
                ) : null}
                <ComposerEditor
                  ariaLabel={t('web.workplace.messageAgents')}
                  disabled={false}
                  mention
                  onChange={updateDraft}
                  onFiles={(files) => void addAttachments(files)}
                  onKeyDown={(event) => {
                    if (event.isComposing || event.keyCode === 229) return false;
                    if (!menuOpen && event.key === 'Escape' && room.replyTarget !== undefined) {
                      event.preventDefault();
                      room.cancelReply?.();
                      return true;
                    }
                    if (!menuOpen) return false;
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setActive((i) => (i + 1) % options.length);
                      return true;
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      setActive((i) => (i - 1 + options.length) % options.length);
                      return true;
                    }
                    if (event.key === 'Enter' || event.key === 'Tab') {
                      event.preventDefault();
                      const target = options[active];
                      if (target) acceptMention(target);
                      return true;
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setMention(null);
                      return true;
                    }
                    return false;
                  }}
                  onMentionChange={(nextMention, position) => {
                    if (!mention || !nextMention || mention.start !== nextMention.start) setActive(0);
                    setMention(nextMention);
                    setMentionMenuPosition(position);
                  }}
                  onPasteText={(text) => {
                    if (text.length <= LONG_PASTE_TEXT_THRESHOLD) return false;
                    setAttachments((current) => [...current, pastedTextDraftAttachment(text)]);
                    return true;
                  }}
                  onSubmit={submit}
                  ref={editorRef}
                  sendShortcut={room.sendShortcut}
                  value={draft}
                />
                <input
                  multiple
                  onChange={(event) => {
                    if (event.currentTarget.files) void addAttachments(event.currentTarget.files);
                    event.currentTarget.value = '';
                  }}
                  ref={fileInputRef}
                  style={{ display: 'none' }}
                  type="file"
                />
              </>
            }
            hasSendableContent={draft.trim().length > 0 || attachments.length > 0}
            mentionMenu={
              menuOpen ? (
                <div
                  className="glass-surface"
                  style={{
                    position: 'absolute',
                    left: mentionMenuPosition?.left ?? 18,
                    bottom: mentionMenuPosition?.bottom ?? 88,
                    minWidth: 180,
                    overflow: 'hidden',
                    background: 'var(--popover, var(--card))',
                    border: '1px solid var(--border)',
                    boxShadow: '0 18px 48px color-mix(in srgb, var(--foreground) 14%, transparent)',
                    zIndex: 80
                  }}
                >
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
                      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
                        <span
                          aria-hidden="true"
                          style={{
                            WebkitMaskImage: 'url("/monad-icon-vector-solid.svg")',
                            WebkitMaskPosition: 'center',
                            WebkitMaskRepeat: 'no-repeat',
                            WebkitMaskSize: 'contain',
                            background: 'currentColor',
                            display: 'inline-block',
                            flex: 'none',
                            height: 13,
                            maskImage: 'url("/monad-icon-vector-solid.svg")',
                            maskPosition: 'center',
                            maskRepeat: 'no-repeat',
                            maskSize: 'contain',
                            transform: 'translateY(1px)',
                            width: 13
                          }}
                        />
                        {target.name}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null
            }
            onAttachFile={() => fileInputRef.current?.click()}
            onStop={room.pauseAll}
            onSubmit={submit}
            onVoiceText={(text) => {
              editorRef.current?.appendText(text);
              setMention(null);
            }}
            value={draft}
            voice={{
              modelCheckPending: host.voiceModelState === 'checking',
              modelConfigured: host.voiceModelState === 'configured',
              modelCheckFailed: host.voiceModelState === 'failed',
              onSettingsClick: () => host.openStudio('models'),
              transcribeAudio: async (audio) => {
                const body = await audioBlobToBase64(audio);
                return (await transcribeAudio(body).unwrap()).text;
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
  hasSendableContent,
  mentionMenu,
  onAttachFile,
  onStop,
  onSubmit,
  onVoiceText,
  value,
  voice,
  voiceCancelSignal
}: {
  ariaLabel: string;
  busy?: boolean;
  disabled?: boolean;
  editorSlot: ReactNode;
  hasSendableContent?: boolean;
  mentionMenu?: ReactNode;
  onAttachFile?: () => void;
  onStop?: () => void;
  onSubmit: () => void;
  onVoiceText?: (text: string) => void;
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
  const {
    listening,
    toggleVoice,
    voiceActive,
    voiceBusy,
    voiceDebug,
    voiceDisabledReason,
    voiceLevel,
    voiceModelConfigured,
    voiceSpectrum
  } = useComposerVoice({
    cancelSignal: voiceCancelSignal,
    onVoiceText,
    voice
  });
  const canSend = Boolean(hasSendableContent ?? value.trim().length > 0) && !disabled && !voiceActive;
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
        ? 'Transcribing audio'
        : listening
          ? 'Recording voice input'
          : effectiveVoiceDisabledReason
            ? effectiveVoiceDisabledReason
            : 'Voice input';
  return (
    <UnifiedComposer
      ariaBusy={voiceBusy}
      ariaLabel="Message composer"
      controls={{
        attach: (
          <ComposerIconButton
            ariaLabel="Attach file"
            disabled={disabled}
            onClick={onAttachFile}
            title="Attach file"
          >
            <HugeiconsIcon
              icon={Attachment01Icon}
              size={17}
            />
          </ComposerIconButton>
        ),
        submit: (
          <ComposerSubmitButton
            ariaLabel={canStop ? 'Stop' : ariaLabel}
            canSend={canSend}
            canStop={Boolean(canStop)}
            disabled={submitDisabled}
            onClick={canStop ? onStop : onSubmit}
          />
        ),
        voice: (
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
          />
        )
      }}
      editor={editorSlot}
      mentionMenu={mentionMenu}
      voiceDebug={voiceDebug ? <VoiceDebugPanel debug={voiceDebug} /> : null}
      voiceLevel={voiceLevel}
      voiceSpectrum={voiceSpectrum}
      voiceState={voiceBusy || voiceChecking ? 'busy' : listening ? 'listening' : 'idle'}
    />
  );
}

function VoiceDebugPanel({
  debug
}: {
  debug: NonNullable<ReturnType<typeof useComposerVoice>['voiceDebug']>;
}): ReactElement {
  const rows = [
    ['event', debug.event],
    ['time', debug.timestamp],
    ['mode', debug.mode],
    ['recorder', debug.recorderState ?? 'n/a'],
    ['chunks', String(debug.chunkCount)],
    ['last chunk', debug.lastChunkSize == null ? 'n/a' : `${debug.lastChunkSize} B`],
    ['audio', debug.audioSize == null ? 'n/a' : `${debug.audioSize} B`],
    ['media', debug.mediaType ?? 'n/a'],
    ['transcribe', debug.transcribeStatus],
    ['requestData', debug.requestDataCalled ? 'yes' : 'no'],
    ['discarded', debug.discarded ? 'yes' : 'no'],
    ['detected', debug.voiceDetected ? 'yes' : 'no'],
    ['available', debug.voiceAvailable ? 'yes' : 'no'],
    ['model', debug.voiceModelConfigured ? 'configured' : 'missing'],
    ['reason', debug.voiceDisabledReason ?? 'none'],
    ['error', debug.lastError ?? 'none']
  ];

  return (
    <details
      style={{
        background: 'color-mix(in srgb, var(--muted) 48%, transparent)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        color: 'var(--muted-foreground)',
        fontFamily: sans,
        fontSize: 11,
        margin: '0 12px 12px',
        padding: '8px 10px'
      }}
    >
      <summary style={{ color: 'var(--foreground)', fontSize: 12, fontWeight: 600 }}>Voice debug</summary>
      <dl
        style={{
          display: 'grid',
          gap: '3px 12px',
          gridTemplateColumns: '88px minmax(0, 1fr)',
          margin: '8px 0 0'
        }}
      >
        {rows.map(([label, value]) => (
          <div
            key={label}
            style={{ display: 'contents' }}
          >
            <dt style={{ color: 'color-mix(in srgb, var(--muted-foreground) 74%, transparent)', fontFamily: mono }}>
              {label}
            </dt>
            <dd style={{ color: 'var(--foreground)', fontFamily: mono, margin: 0, overflowWrap: 'anywhere' }}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
