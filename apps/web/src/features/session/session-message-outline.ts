import type { UIMessageOutlineItem } from '@monad/protocol';
import type { MessageOutlineItem } from '@monad/ui/components/MessageOutline';
import type { ViewItem } from './chat-view-items';

export type SessionMessageOutlineItem = MessageOutlineItem & { preview: string };

/** Formats a message's ISO timestamp for the outline; receives undefined when the row has none. */
export type OutlineTimeFormatter = (iso: string | undefined) => string;

export function sessionMessageOutlineItems(
  items: ViewItem[],
  emptyLabel: (number: number) => string,
  formatTime: OutlineTimeFormatter
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
        time: formatTime(item.seq)
      }
    ];
  });
}

export function completeSessionMessageOutlineItems(
  outline: UIMessageOutlineItem[],
  renderedItems: SessionMessageOutlineItem[],
  emptyLabel: (number: number) => string,
  formatTime: OutlineTimeFormatter
): SessionMessageOutlineItem[] {
  const complete = outline.map((item, index) => {
    const label = item.text.trim().replace(/\s+/g, ' ');
    return {
      id: item.id,
      index,
      label: label || emptyLabel(index + 1),
      preview: item.text,
      time: formatTime(item.at)
    };
  });
  const known = new Set(outline.map((item) => item.id));
  for (const item of renderedItems) {
    if (!known.has(item.id)) complete.push({ ...item, index: complete.length });
  }
  return complete;
}
