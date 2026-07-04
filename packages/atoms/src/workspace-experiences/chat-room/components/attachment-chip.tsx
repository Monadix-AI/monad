'use client';

import type { MessageAttachment } from '../../project/types.ts';

import { Attachment01Icon, Download04Icon, EyeIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { isPreviewableAttachmentMime } from '@monad/protocol';
import { workspaceMono as mono, workspaceSans as sans } from '@monad/ui/components/AgentAvatar';
import { useState } from 'react';

import { workspaceExperienceT } from '../../i18n.ts';

export type AttachmentClient = {
  fetch(path: string): Promise<Response>;
};

let attachmentClient: AttachmentClient | undefined;

export function configureWorkspaceAttachmentClient(client: AttachmentClient): void {
  attachmentClient = client;
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

export function AttachmentChip({ attachment }: { attachment: MessageAttachment }): React.ReactElement {
  const t = workspaceExperienceT();
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const previewable = isPreviewableAttachmentMime(attachment.mime);
  const client = attachmentClient;
  const togglePreview = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (content !== null || loading) return;
    if (!client) {
      setError(true);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const res = await client.fetch(`/v1/attachments/${attachment.id}`);
      if (!res.ok) throw new Error(`attachment fetch failed: ${res.status}`);
      const body = (await res.json()) as { text?: string; truncated?: boolean };
      const text = typeof body.text === 'string' ? body.text : '';
      setContent(body.truncated ? `${text}...` : text);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };
  const download = async () => {
    if (!client) {
      setError(true);
      setExpanded(true);
      return;
    }
    try {
      const res = await client.fetch(`/v1/attachments/${attachment.id}?download=1`);
      if (!res.ok) throw new Error(`attachment download failed: ${res.status}`);
      const blobUrl = URL.createObjectURL(await res.blob());
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = attachment.name;
      anchor.click();
      URL.revokeObjectURL(blobUrl);
    } catch {
      setError(true);
      setExpanded(true);
    }
  };
  const actionStyle: React.CSSProperties = {
    alignItems: 'center',
    background: 'transparent',
    border: 'none',
    color: 'var(--accent-blue)',
    display: 'inline-flex',
    fontFamily: sans,
    fontSize: 12,
    gap: 4,
    padding: 0,
    textDecoration: 'none'
  };
  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        color: 'var(--foreground)',
        fontFamily: sans,
        fontSize: 13,
        marginTop: 8,
        padding: '8px 10px'
      }}
    >
      <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 10, minWidth: 0 }}>
        <HugeiconsIcon
          icon={Attachment01Icon}
          size={14}
          style={{ color: 'var(--muted-foreground)', flexShrink: 0 }}
        />
        <span
          style={{ fontWeight: 600, overflowWrap: 'anywhere' }}
          title={attachment.path}
        >
          {attachment.name}
        </span>
        <span style={{ color: 'var(--muted-foreground)', fontFamily: mono, fontSize: 11 }}>
          {formatAttachmentSize(attachment.bytes)}
        </span>
        {previewable ? (
          <button
            onClick={() => void togglePreview()}
            style={actionStyle}
            type="button"
          >
            <HugeiconsIcon
              icon={EyeIcon}
              size={13}
            />
            {expanded ? t('web.workplace.attachmentCollapse') : t('web.workplace.attachmentPreview')}
          </button>
        ) : null}
        <button
          onClick={() => void download()}
          style={actionStyle}
          type="button"
        >
          <HugeiconsIcon
            icon={Download04Icon}
            size={13}
          />
          {t('web.workplace.attachmentDownload')}
        </button>
      </div>
      {expanded ? (
        <pre
          style={{
            background: 'var(--secondary)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            fontFamily: mono,
            fontSize: 12,
            lineHeight: 1.5,
            margin: '8px 0 0',
            maxHeight: '40vh',
            overflow: 'auto',
            padding: '8px 10px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {error ? t('web.workplace.attachmentLoadError') : loading || content === null ? '...' : content}
        </pre>
      ) : null}
    </div>
  );
}
