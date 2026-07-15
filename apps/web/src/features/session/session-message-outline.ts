import type { MessageOutlineItem } from '@monad/ui/components/MessageOutline';
import type { ViewItem } from './chat-view-items';

export type SessionMessageOutlineItem = MessageOutlineItem & { preview: string };

export function sessionMessageOutlineItems(
  items: ViewItem[],
  emptyLabel: (number: number) => string,
  timeUnavailable: string
): SessionMessageOutlineItem[] {
  return items.flatMap((item, index) => {
    if (!('role' in item) || item.role !== 'user') return [];
    const preview = item.text.trim().replace(/\s+/g, ' ');
    return [
      {
        id: item.id,
        index,
        label: preview || emptyLabel(index + 1),
        preview: item.text,
        time: timeUnavailable
      }
    ];
  });
}
