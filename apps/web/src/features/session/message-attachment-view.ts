import type { MessageAttachment } from '@monad/protocol';

export type MessageAttachmentView = MessageAttachment & {
  imageSrc?: string;
};
