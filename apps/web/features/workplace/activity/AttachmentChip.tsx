import type { MessageAttachment } from '../types';

import { Attachment01Icon, Download04Icon, EyeIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { isPreviewableAttachmentMime } from '@monad/protocol';
import { useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { formatAttachmentSize } from '@/features/studio/skills-settings/utils';
import { useMonadRuntime } from '@/lib/monad-runtime-provider';
import { mono, sans } from '../styles';

/** File-reference chip on a wall message: renders the structured attachment (name, size, local
 *  path) with download plus an inline text preview. Content is read from the referenced file on
 *  demand — a moved/deleted file surfaces as a load error, matching reference semantics. Requests
 *  go through the runtime client so they hit the resolved daemon connection (dev proxy, co-served
 *  release, or remote daemon with Bearer) instead of a hardcoded origin. */
export function AttachmentChip({ attachment }: { attachment: MessageAttachment }): React.ReactElement {
  const t = useT();
  const { client } = useMonadRuntime();
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const previewable = isPreviewableAttachmentMime(attachment.mime);
  const togglePreview = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (content !== null || loading) return;
    setLoading(true);
    setError(false);
    try {
      const res = await client.fetch(`/v1/attachments/${attachment.id}`);
      if (!res.ok) throw new Error(`attachment fetch failed: ${res.status}`);
      const body = (await res.json()) as { text?: string; truncated?: boolean };
      const text = typeof body.text === 'string' ? body.text : '';
      setContent(body.truncated ? `${text}…` : text);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };
  // Blob download instead of a plain href: the daemon may be a different origin needing the
  // Bearer header, which an <a href> cannot send.
  const download = async () => {
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
          {error ? t('web.workplace.attachmentLoadError') : loading || content === null ? '…' : content}
        </pre>
      ) : null}
    </div>
  );
}
