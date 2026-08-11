import type { MessageAttachment } from '../../experience/types.ts';

import { createContext, useContext } from 'react';

export type FilePreviewContextValue = {
  attachments: readonly MessageAttachment[];
  onOpenAttachment?: (attachment: MessageAttachment, line?: number) => void;
};

export const FilePreviewContext = createContext<FilePreviewContextValue>({ attachments: [] });

export function useFilePreviewContext(): FilePreviewContextValue {
  return useContext(FilePreviewContext);
}
