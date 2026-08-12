import type { FilePreviewTarget } from '@monad/protocol';

export function filePreviewUrl(target: FilePreviewTarget, mode?: 'download' | 'inline'): string {
  const params = new URLSearchParams();
  if ('attachmentId' in target) params.set('attachmentId', target.attachmentId);
  else {
    params.set('path', target.path);
    params.set('sessionId', target.sessionId);
    params.set('projectMemberId', target.projectMemberId);
  }
  if (mode) params.set(mode, '1');
  return `/v1/file-preview?${params.toString()}`;
}
