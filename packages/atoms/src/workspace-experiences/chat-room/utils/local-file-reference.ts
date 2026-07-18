import type { MessageAttachment } from '../../experience/types.ts';

export interface LocalFileReference {
  attachment?: MessageAttachment;
  line?: number;
  path: string;
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function normalizeLocalFileTarget(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) return '';
  if (/^file:/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return decodePath(url.host ? `//${url.host}${url.pathname}` : url.pathname);
    } catch {
      return '';
    }
  }
  return decodePath(trimmed);
}

export function resolveLocalFileReference(href: string, attachments: readonly MessageAttachment[]): LocalFileReference {
  const fragmentIndex = href.indexOf('#');
  const target = fragmentIndex === -1 ? href : href.slice(0, fragmentIndex);
  const fragment = fragmentIndex === -1 ? '' : href.slice(fragmentIndex + 1);
  const path = normalizeLocalFileTarget(target);
  const lineMatch = /^L([1-9]\d*)$/.exec(fragment);
  const attachment = attachments.find((item) => normalizeLocalFileTarget(item.path) === path);
  return {
    ...(attachment ? { attachment } : {}),
    ...(lineMatch ? { line: Number.parseInt(lineMatch[1] ?? '1', 10) } : {}),
    path
  };
}
