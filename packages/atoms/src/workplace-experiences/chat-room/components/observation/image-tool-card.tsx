import type { ObservationItem } from './types.ts';

import { AttachmentCard, ImageGalleryDialog } from '@monad/ui';
import { useState } from 'react';

import { workplaceExperienceT } from '../../../i18n.ts';
import { observationContractRawEvents } from './provenance.ts';

export type ImageToolView = {
  imageSrc: string;
  name: string;
  path?: string;
  sizeLabel: string;
};

function providerItem(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const params = record.params;
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const item = (params as Record<string, unknown>).item;
    if (item && typeof item === 'object' && !Array.isArray(item)) return item as Record<string, unknown>;
  }
  return record;
}

function imageDataUrl(value: string): string | undefined {
  if (value.startsWith('data:image/')) return value;
  const mime = value.startsWith('iVBOR')
    ? 'image/png'
    : value.startsWith('/9j/')
      ? 'image/jpeg'
      : value.startsWith('UklGR')
        ? 'image/webp'
        : value.startsWith('R0lGOD')
          ? 'image/gif'
          : undefined;
  return mime ? `data:${mime};base64,${value}` : undefined;
}

function decodedImageBytes(value: string): number {
  const base64 = value.includes(',') ? (value.split(',').at(-1) ?? '') : value;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0));
}

function formatImageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

export function imageToolView(
  call: ObservationItem | undefined,
  result: ObservationItem | undefined,
  contractEvents: unknown[]
): ImageToolView | null {
  const name = (call?.tool?.name ?? result?.tool?.name ?? '').replace(/[-_\s]/g, '').toLowerCase();
  if (name !== 'imagegeneration') return null;
  const item = observationContractRawEvents(contractEvents)
    .map(providerItem)
    .findLast((candidate) => typeof candidate?.result === 'string' && candidate.result.length > 0);
  if (!item || typeof item.result !== 'string') return null;
  const imageSrc = imageDataUrl(item.result);
  if (!imageSrc) return null;
  const path =
    typeof item.savedPath === 'string'
      ? item.savedPath
      : typeof item.saved_path === 'string'
        ? item.saved_path
        : undefined;
  const nameFromPath = path?.split(/[\\/]/).filter(Boolean).at(-1);
  return {
    imageSrc,
    name: nameFromPath ?? 'generated-image.png',
    ...(path ? { path } : {}),
    sizeLabel: formatImageSize(decodedImageBytes(item.result))
  };
}

export function ImageToolCard({ view }: { view: ImageToolView }): React.ReactElement {
  const t = workplaceExperienceT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <AttachmentCard
        mime={view.imageSrc.slice(5, view.imageSrc.indexOf(';'))}
        name={view.name}
        onPreview={() => setOpen(true)}
        path={view.path}
        previewable
        previewLabel={t('web.workplace.attachmentPreview')}
        sizeLabel={view.sizeLabel}
      />
      <ImageGalleryDialog
        index={0}
        labels={{
          close: t('web.workplace.imagePreviewClose'),
          next: t('web.workplace.imagePreviewNext'),
          previous: t('web.workplace.imagePreviewPrevious'),
          zoomIn: t('web.workplace.imagePreviewZoomIn'),
          zoomOut: t('web.workplace.imagePreviewZoomOut')
        }}
        onClose={() => setOpen(false)}
        open={open}
        slides={[{ alt: view.name, src: view.imageSrc }]}
      />
    </>
  );
}
