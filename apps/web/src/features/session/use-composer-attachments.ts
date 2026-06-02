import type { AttachmentId, SendMessageAttachment } from '@monad/protocol';
import type { ComposerAttachmentItem } from '@monad/ui';
import type { MessageAttachmentView } from './message-attachment-view';

import { newId } from '@monad/protocol';
import {
  type DraftMessageAttachment,
  draftAttachmentBase64,
  fileToDraftAttachment,
  sendableDraftAttachments,
  useOpenDraftAttachmentMutation
} from '@monad/sdk-experience/react';
import { useCallback, useEffect, useMemo, useReducer } from 'react';

type ComposerAttachmentError = 'open' | 'read' | null;

export interface ComposerAttachmentState {
  attachments: DraftMessageAttachment[];
  error: ComposerAttachmentError;
  scopeKey: string;
}

type ComposerAttachmentEvent =
  | { attachments: DraftMessageAttachment[]; type: 'add' }
  | { error: ComposerAttachmentError; type: 'error' }
  | { localId: string; type: 'remove' }
  | { scopeKey: string; type: 'scope' }
  | { type: 'clear' };

export function composerAttachmentState(scopeKey: string): ComposerAttachmentState {
  return { attachments: [], error: null, scopeKey };
}

export function reduceComposerAttachments(
  state: ComposerAttachmentState,
  event: ComposerAttachmentEvent
): ComposerAttachmentState {
  switch (event.type) {
    case 'add':
      return { ...state, attachments: [...state.attachments, ...event.attachments] };
    case 'remove':
      return { ...state, attachments: state.attachments.filter((item) => item.localId !== event.localId) };
    case 'clear':
      return { ...state, attachments: [], error: null };
    case 'error':
      return { ...state, error: event.error };
    case 'scope':
      return event.scopeKey === state.scopeKey ? state : composerAttachmentState(event.scopeKey);
  }
}

export function composerAttachmentView(attachment: DraftMessageAttachment): ComposerAttachmentItem {
  return {
    contentType: attachment.mediaType,
    id: attachment.localId,
    imageSrc: attachment.kind === 'image' ? `data:${attachment.mediaType};base64,${attachment.dataBase64}` : undefined,
    name: attachment.name,
    openable: Boolean(attachment.localFile || attachment.kind === 'image' || attachment.kind === 'text'),
    size: attachment.size
  };
}

export function messageAttachmentsFromSend(
  attachments: readonly SendMessageAttachment[],
  options: {
    createdAt?: string;
    newAttachmentId?: (index: number) => AttachmentId;
  } = {}
): MessageAttachmentView[] {
  const createdAt = options.createdAt ?? new Date().toISOString();
  return attachments.map((attachment, index) => ({
    id: options.newAttachmentId?.(index) ?? newId('att'),
    bytes: attachment.size,
    createdAt,
    ...(attachment.kind === 'image'
      ? { imageSrc: `data:${attachment.mediaType};base64,${attachment.dataBase64}` }
      : {}),
    mime: attachment.mediaType || 'application/octet-stream',
    name: attachment.name
  }));
}

export function useComposerAttachments(scopeKey: string) {
  const [state, dispatch] = useReducer(reduceComposerAttachments, scopeKey, composerAttachmentState);
  const [openDraftAttachment] = useOpenDraftAttachmentMutation();

  useEffect(() => {
    dispatch({ type: 'scope', scopeKey });
  }, [scopeKey]);

  const addFiles = useCallback(async (files: File[] | FileList): Promise<void> => {
    const settled = await Promise.allSettled([...files].map(fileToDraftAttachment));
    const attachments = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    if (attachments.length) dispatch({ type: 'add', attachments });
    dispatch({
      type: 'error',
      error: settled.some((result) => result.status === 'rejected') ? 'read' : null
    });
  }, []);

  const clearAttachments = useCallback(() => {
    dispatch({ type: 'clear' });
  }, []);

  const removeAttachment = useCallback((localId: string) => {
    dispatch({ type: 'remove', localId });
  }, []);

  const openAttachment = useCallback(
    async (localId: string): Promise<void> => {
      const attachment = state.attachments.find((item) => item.localId === localId);
      if (!attachment) return;
      try {
        const dataBase64 = await draftAttachmentBase64(attachment);
        if (!dataBase64) return;
        await openDraftAttachment({
          dataBase64,
          mediaType: attachment.mediaType,
          name: attachment.name
        }).unwrap();
        dispatch({ type: 'error', error: null });
      } catch {
        dispatch({ type: 'error', error: 'open' });
      }
    },
    [openDraftAttachment, state.attachments]
  );

  const attachmentItems = useMemo(() => state.attachments.map(composerAttachmentView), [state.attachments]);
  const sendableAttachments = useMemo<SendMessageAttachment[]>(
    () => sendableDraftAttachments(state.attachments),
    [state.attachments]
  );

  return {
    addFiles,
    attachmentItems,
    attachments: state.attachments,
    clearAttachments,
    error: state.error,
    openAttachment,
    removeAttachment,
    sendableAttachments
  };
}
