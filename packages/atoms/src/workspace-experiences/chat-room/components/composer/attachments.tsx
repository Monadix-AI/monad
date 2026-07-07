'use client';

import type { SendMessageAttachment } from '@monad/protocol';
import type { ReactElement } from 'react';

import {
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
import { ImageZoom } from '@monad/ui';
import { workspaceMono as mono, workspaceSans as sans } from '@monad/ui/components/AgentAvatar';

const TEXT_ATTACHMENT_MAX_BYTES = 512_000;

export type DraftAttachment = SendMessageAttachment & {
  localFile?: File;
  localId: string;
  virtualKind?: 'pasted-text';
};
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

export function sendableAttachments(attachments: DraftAttachment[]): SendMessageAttachment[] {
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

export function fileToBase64(file: File): Promise<string> {
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

export async function fileToAttachment(file: File): Promise<DraftAttachment> {
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

export function pastedTextAttachment(text: string): DraftAttachment {
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

export function attachmentMediaType(attachment: DraftAttachment): string {
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

export function AttachmentPreviewStrip({
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

function imageAttachmentSrc(attachment: DraftAttachment): string | null {
  return attachment.kind === 'image' ? `data:${attachment.mediaType};base64,${attachment.dataBase64}` : null;
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
  const imageSrc = imageAttachmentSrc(attachment);
  const thumbnail = (
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
        <ImageZoom
          className="[&_[data-rmiz-content]]:h-full [&_[data-rmiz-content]]:w-full [&_[data-rmiz]]:h-full [&_[data-rmiz]]:w-full [&_img]:h-full [&_img]:w-full [&_img]:object-cover"
          zoomMargin={24}
        >
          {/* biome-ignore lint/performance/noImgElement: draft attachment previews use local data URLs, not optimizable remote assets. */}
          <img
            alt={`Preview of ${displayName}`}
            draggable={false}
            src={imageSrc}
          />
        </ImageZoom>
      ) : (
        <HugeiconsIcon
          icon={visual.icon}
          size={18}
        />
      )}
    </div>
  );
  const details = (
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
  );
  const contentStyle = {
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
  } as const;
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
      {imageSrc ? (
        <div style={contentStyle}>
          {thumbnail}
          {details}
        </div>
      ) : (
        <button
          aria-label={`Open ${displayName}`}
          onClick={onOpen}
          style={contentStyle}
          type="button"
        >
          {thumbnail}
          {details}
        </button>
      )}
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
