'use client';

import type { SendMessageAttachment } from '@monad/protocol';
import type { ComposerEditorHandle } from '@monad/ui';
import type { ReactElement, ReactNode } from 'react';
import type { QuestionView } from '../../../experience/types.ts';
import type { ProjectComposerSurface } from '../../utils/composer.ts';

import {
  Attachment01Icon,
  Cancel01Icon,
  File01Icon,
  FileArchiveIcon,
  FileAudioIcon,
  FileBracesIcon,
  FileCodeIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTypeIcon,
  FileVideoIcon,
  TextIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { useOpenDraftAttachmentMutation, useTranscribeAudioMutation } from '@monad/sdk-atom-client-rtk';
import { ComposerEditor, ComposerSubmitButton, ComposerSurface, ComposerSwap, ComposerVoiceButton } from '@monad/ui';
import { workspaceMono as mono, workspaceSans as sans } from '@monad/ui/components/AgentAvatar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useWorkspaceExperienceHost } from '../../../host-context.tsx';
import { workspaceExperienceT } from '../../../i18n.ts';
import { ApprovalStack } from './approval-stack.tsx';
import { audioBlobToBase64 } from './audio.ts';
import { QuestionStack } from './question-stack.tsx';
import { useComposerVoice } from './use-composer-voice.ts';

const COMPOSER_DRAFT_STORAGE_PREFIX = 'monad:chat-room-composer-draft:';
const LONG_PASTE_TEXT_THRESHOLD = 1000;
const TEXT_ATTACHMENT_MAX_BYTES = 512_000;

type DraftAttachment = SendMessageAttachment & { localFile?: File; localId: string; virtualKind?: 'pasted-text' };
export type ComposerDroppedFiles = { files: File[]; nonce: number };
type AttachmentVisual = {
  accent: string;
  icon: IconSvgElement;
  label: string;
};

const archiveExtensions = new Set(['7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'zip']);
const audioExtensions = new Set(['aac', 'aiff', 'flac', 'm4a', 'mp3', 'ogg', 'wav']);
const codeExtensions = new Set([
  'c',
  'cpp',
  'css',
  'go',
  'html',
  'java',
  'js',
  'jsx',
  'kt',
  'mdx',
  'php',
  'py',
  'rb',
  'rs',
  'sh',
  'sql',
  'swift',
  'ts',
  'tsx',
  'vue'
]);
const spreadsheetExtensions = new Set(['csv', 'numbers', 'ods', 'tsv', 'xls', 'xlsx']);
const textExtensions = new Set(['log', 'md', 'rst', 'txt', 'xml', 'yaml', 'yml']);
const videoExtensions = new Set(['avi', 'm4v', 'mov', 'mp4', 'mpeg', 'webm']);

function newAttachmentId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `att:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function sendableAttachments(attachments: DraftAttachment[]): SendMessageAttachment[] {
  return attachments.map(
    ({ localFile: _localFile, localId: _localId, virtualKind: _virtualKind, ...attachment }) => attachment
  );
}

function fileTextLike(file: File): boolean {
  return (
    file.type.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/javascript', 'application/typescript'].includes(file.type) ||
    /\.(csv|json|log|md|txt|xml|yaml|yml)$/i.test(file.name)
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

async function fileToAttachment(file: File): Promise<DraftAttachment> {
  if (file.type.startsWith('image/')) {
    return {
      kind: 'image',
      localFile: file,
      localId: newAttachmentId(),
      name: file.name || 'pasted-image',
      mediaType: file.type,
      size: file.size,
      dataBase64: await fileToBase64(file)
    };
  }
  if (fileTextLike(file) && file.size <= TEXT_ATTACHMENT_MAX_BYTES) {
    return {
      kind: 'text',
      localFile: file,
      localId: newAttachmentId(),
      name: file.name || 'pasted-text.txt',
      mediaType: file.type || 'text/plain',
      size: file.size,
      text: await file.text()
    };
  }
  return {
    kind: 'file-meta',
    localFile: file,
    localId: newAttachmentId(),
    name: file.name || 'file',
    ...(file.type ? { mediaType: file.type } : {}),
    size: file.size
  };
}

function pastedTextAttachment(text: string): DraftAttachment {
  const encoded = new TextEncoder().encode(text);
  const truncationNote = `\n\n[truncated: pasted text exceeded ${TEXT_ATTACHMENT_MAX_BYTES} bytes]`;
  let cappedText = text;
  if (encoded.byteLength > TEXT_ATTACHMENT_MAX_BYTES) {
    const budget = TEXT_ATTACHMENT_MAX_BYTES - new TextEncoder().encode(truncationNote).byteLength;
    cappedText = `${new TextDecoder().decode(encoded.slice(0, Math.max(0, budget)))}${truncationNote}`;
  }
  const file = new File([cappedText], 'pasted-text.txt', { type: 'text/plain' });
  return {
    kind: 'text',
    localFile: file,
    localId: newAttachmentId(),
    name: 'Pasted',
    mediaType: 'text/plain',
    size: new Blob([cappedText]).size,
    text: cappedText,
    virtualKind: 'pasted-text'
  };
}

function attachmentSummary(attachment: DraftAttachment): string {
  if (attachment.virtualKind === 'pasted-text') return 'Pasted text';
  if (attachment.kind === 'image') return `${attachment.name} image`;
  if (attachment.kind === 'text') return `${attachment.name} text`;
  return `${attachment.name} file`;
}

function attachmentDisplayName(attachment: DraftAttachment): string {
  return attachment.virtualKind === 'pasted-text' ? 'Pasted' : attachment.name;
}

function attachmentExtension(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return extension === name.toLowerCase() ? '' : extension;
}

function attachmentMediaType(attachment: DraftAttachment): string {
  return attachment.kind === 'file-meta' ? (attachment.mediaType ?? '') : attachment.mediaType;
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function attachmentVisual(attachment: DraftAttachment): AttachmentVisual {
  const mediaType = attachmentMediaType(attachment).toLowerCase();
  const extension = attachmentExtension(attachment.name);
  if (attachment.kind === 'image' || mediaType.startsWith('image/')) {
    return { accent: 'rgb(64 217 198)', icon: FileImageIcon, label: 'Image' };
  }
  if (mediaType.startsWith('audio/') || audioExtensions.has(extension)) {
    return { accent: 'rgb(66 133 244)', icon: FileAudioIcon, label: 'Audio' };
  }
  if (mediaType.startsWith('video/') || videoExtensions.has(extension)) {
    return { accent: 'rgb(145 84 231)', icon: FileVideoIcon, label: 'Video' };
  }
  if (spreadsheetExtensions.has(extension)) {
    return {
      accent: 'rgb(52 168 83)',
      icon: FileSpreadsheetIcon,
      label: extension ? extension.toUpperCase() : 'Sheet'
    };
  }
  if (archiveExtensions.has(extension)) {
    return { accent: 'rgb(251 188 4)', icon: FileArchiveIcon, label: extension ? extension.toUpperCase() : 'Archive' };
  }
  if (extension === 'json' || extension === 'jsonc' || extension === 'jsonl') {
    return { accent: 'rgb(64 217 198)', icon: FileBracesIcon, label: extension.toUpperCase() };
  }
  if (codeExtensions.has(extension)) {
    return { accent: 'rgb(113 104 246)', icon: FileCodeIcon, label: extension.toUpperCase() };
  }
  if (attachment.kind === 'text' || mediaType.startsWith('text/') || textExtensions.has(extension)) {
    return { accent: 'rgb(66 133 244)', icon: TextIcon, label: extension ? extension.toUpperCase() : 'Text' };
  }
  if (extension === 'otf' || extension === 'ttf' || extension === 'woff' || extension === 'woff2') {
    return { accent: 'rgb(189 193 198)', icon: FileTypeIcon, label: extension.toUpperCase() };
  }
  return { accent: 'rgb(189 193 198)', icon: File01Icon, label: extension ? extension.toUpperCase() : 'File' };
}

function AttachmentPreviewStrip({
  attachments,
  onOpen,
  onRemove
}: {
  attachments: DraftAttachment[];
  onOpen: (attachment: DraftAttachment) => void;
  onRemove: (index: number) => void;
}): ReactElement {
  return (
    <ul
      aria-label="Attachments"
      className="[&::-webkit-scrollbar]:hidden"
      style={{
        display: 'flex',
        gap: 8,
        listStyle: 'none',
        margin: 0,
        overflowX: 'auto',
        overscrollBehaviorX: 'contain',
        padding: 0,
        scrollbarWidth: 'none'
      }}
    >
      {attachments.map((attachment, index) => (
        <AttachmentPreviewCard
          attachment={attachment}
          key={attachment.localId}
          onOpen={() => onOpen(attachment)}
          onRemove={() => onRemove(index)}
        />
      ))}
    </ul>
  );
}

function AttachmentPreviewCard({
  attachment,
  onOpen,
  onRemove
}: {
  attachment: DraftAttachment;
  onOpen: () => void;
  onRemove: () => void;
}): ReactElement {
  const visual = attachmentVisual(attachment);
  const displayName = attachmentDisplayName(attachment);
  const imageSrc = attachment.kind === 'image' ? `data:${attachment.mediaType};base64,${attachment.dataBase64}` : null;
  return (
    <li
      style={{
        background: 'color-mix(in srgb, var(--card) 76%, var(--background) 24%)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        color: 'var(--foreground)',
        flex: '0 0 168px',
        height: 56,
        overflow: 'hidden',
        position: 'relative',
        userSelect: 'none'
      }}
      title={attachmentSummary(attachment)}
    >
      <button
        aria-label={`Open ${displayName}`}
        onClick={onOpen}
        style={{
          alignItems: 'center',
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          display: 'flex',
          gap: 8,
          height: '100%',
          minWidth: 0,
          padding: '7px 32px 7px 8px',
          textAlign: 'left',
          width: '100%'
        }}
        type="button"
      >
        <div
          style={{
            alignItems: 'center',
            background: imageSrc ? 'var(--secondary)' : `color-mix(in srgb, ${visual.accent} 18%, transparent)`,
            border: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
            borderRadius: 8,
            color: visual.accent,
            display: 'flex',
            flex: '0 0 38px',
            height: 38,
            justifyContent: 'center',
            overflow: 'hidden',
            width: 38
          }}
        >
          {imageSrc ? (
            <div
              aria-hidden="true"
              style={{
                backgroundImage: `url("${imageSrc}")`,
                backgroundPosition: 'center',
                backgroundSize: 'cover',
                height: '100%',
                width: '100%'
              }}
            />
          ) : (
            <HugeiconsIcon
              icon={visual.icon}
              size={18}
            />
          )}
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              color: 'var(--foreground)',
              fontFamily: sans,
              fontSize: 12,
              fontWeight: 600,
              lineHeight: '16px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {displayName}
          </div>
          <div
            style={{
              color: 'var(--muted-foreground)',
              display: 'flex',
              fontFamily: mono,
              fontSize: 10,
              gap: 5,
              lineHeight: '14px',
              minWidth: 0,
              whiteSpace: 'nowrap'
            }}
          >
            <span style={{ color: visual.accent, overflow: 'hidden', textOverflow: 'ellipsis' }}>{visual.label}</span>
            <span>{formatAttachmentSize(attachment.size)}</span>
          </div>
        </div>
      </button>
      <button
        aria-label={`Remove ${displayName}`}
        className="workplace-action"
        onClick={onRemove}
        style={{
          alignItems: 'center',
          border: 'none',
          borderRadius: 999,
          color: 'var(--muted-foreground)',
          display: 'inline-flex',
          height: 22,
          justifyContent: 'center',
          padding: 0,
          position: 'absolute',
          right: 6,
          top: 6,
          width: 22
        }}
        title="Remove attachment"
        type="button"
      >
        <HugeiconsIcon
          icon={Cancel01Icon}
          size={13}
        />
      </button>
    </li>
  );
}

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
  const host = useWorkspaceExperienceHost();
  const t = workspaceExperienceT();
  const [openDraftAttachment] = useOpenDraftAttachmentMutation();
  const [transcribeAudio] = useTranscribeAudioMutation();
  const [draft, setDraft] = useState(() => readComposerDraft(room.draftKey));
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionMenuPosition, setMentionMenuPosition] = useState<{ bottom: number; left: number } | null>(null);
  const [active, setActive] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [askPanelTestAnswered, setAskPanelTestAnswered] = useState(false);
  const [voiceCancelSignal, setVoiceCancelSignal] = useState(0);
  const editorRef = useRef<ComposerEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftKeyRef = useRef(room.draftKey);
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
    const next = await Promise.all([...files].map(fileToAttachment));
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
    const dataBase64 =
      attachment.localFile !== undefined
        ? await fileToBase64(attachment.localFile)
        : attachment.kind === 'image'
          ? attachment.dataBase64
          : attachment.kind === 'text'
            ? await fileToBase64(new File([attachment.text], attachment.name, { type: attachment.mediaType }))
            : null;
    if (!dataBase64) return;
    await openDraftAttachment({
      dataBase64,
      mediaType: attachmentMediaType(attachment) || undefined,
      name: attachment.localFile?.name ?? attachment.name
    }).unwrap();
  };

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    if (sendingRef.current) return;
    const sendKey = `${text}:${attachments.map((attachment) => `${attachment.kind}:${attachment.name}:${attachment.size}`).join('|')}`;
    if (submittingTextRef.current === sendKey) return;
    sendingRef.current = true;
    submittingTextRef.current = sendKey;
    setSubmitting(true);
    updateDraft('');
    setMention(null);
    editorRef.current?.clear();
    try {
      await room.sendDirective({ attachments: sendableAttachments(attachments), text });
      setAttachments([]);
    } catch {
      updateDraft(text);
    } finally {
      submittingTextRef.current = null;
      sendingRef.current = false;
      setSubmitting(false);
      editorRef.current?.focus();
    }
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
              <>
                {attachments.length ? (
                  <AttachmentPreviewStrip
                    attachments={attachments}
                    onOpen={(attachment) => void openAttachment(attachment)}
                    onRemove={removeAttachment}
                  />
                ) : null}
                <ComposerEditor
                  ariaLabel={t('web.workplace.messageAgents')}
                  disabled={submitting}
                  mention
                  onChange={updateDraft}
                  onFiles={(files) => void addAttachments(files)}
                  onKeyDown={(event) => {
                    if (event.isComposing || event.keyCode === 229) return false;
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
                    setAttachments((current) => [...current, pastedTextAttachment(text)]);
                    return true;
                  }}
                  onSubmit={submit}
                  ref={editorRef}
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
    <fieldset
      aria-label="Message composer"
      style={{
        border: 0,
        margin: 0,
        minInlineSize: 0,
        padding: 0
      }}
    >
      <ComposerSurface
        ariaBusy={voiceBusy}
        leftTools={
          <button
            aria-label="Attach file"
            className="workplace-action"
            disabled={disabled}
            onClick={onAttachFile}
            style={{
              alignItems: 'center',
              background: 'transparent',
              border: 'none',
              borderRadius: 999,
              color: 'var(--muted-foreground)',
              display: 'inline-flex',
              height: 32,
              justifyContent: 'center',
              opacity: disabled ? 0.48 : 1,
              padding: 0,
              width: 32
            }}
            title="Attach file"
            type="button"
          >
            <HugeiconsIcon
              icon={Attachment01Icon}
              size={17}
            />
          </button>
        }
        mentionMenu={mentionMenu}
        rightTools={
          <>
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
              style={{ background: 'transparent' }}
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
        voiceLevel={voiceLevel}
        voiceSpectrum={voiceSpectrum}
        voiceState={voiceBusy || voiceChecking ? 'busy' : listening ? 'listening' : 'idle'}
      >
        {editorSlot}
        {voiceDebug ? <VoiceDebugPanel debug={voiceDebug} /> : null}
      </ComposerSurface>
    </fieldset>
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
      <summary style={{ color: 'var(--foreground)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
        Voice debug
      </summary>
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
