import type { SendMessageAttachment } from '@monad/protocol';

export type ProjectFollowUpQueueItem = {
  attachments: SendMessageAttachment[];
  text: string;
};

export function submitProjectFollowUp({
  attachments,
  busy,
  queue,
  text
}: {
  attachments: SendMessageAttachment[];
  busy: boolean;
  queue: ProjectFollowUpQueueItem[];
  text: string;
}): { nextQueue: ProjectFollowUpQueueItem[]; sendNow: ProjectFollowUpQueueItem | null } {
  const item = { attachments, text: text.trim() };
  if (!item.text && item.attachments.length === 0) return { nextQueue: queue, sendNow: null };
  if (busy) return { nextQueue: [...queue, item], sendNow: null };
  return { nextQueue: queue, sendNow: item };
}

export function drainProjectFollowUpQueue({
  busy,
  queue,
  wasBusy
}: {
  busy: boolean;
  queue: ProjectFollowUpQueueItem[];
  wasBusy: boolean;
}): { nextQueue: ProjectFollowUpQueueItem[]; sendNow: ProjectFollowUpQueueItem | null } {
  if (!wasBusy || busy || queue.length === 0) return { nextQueue: queue, sendNow: null };
  return {
    nextQueue: [],
    sendNow: {
      attachments: queue.flatMap((item) => item.attachments),
      text: queue
        .map((item) => item.text)
        .filter(Boolean)
        .join('\n\n')
    }
  };
}
