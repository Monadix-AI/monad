import { mentionToken, parseMentionTokens } from '@/components/MentionText';

export function activeMention(value: string, caret: number): { query: string; start: number } | null {
  const before = value.slice(0, caret);
  const m = before.match(/(?:^|\s)@([\w.-]*)$/);
  if (!m) return null;
  return { query: m[1], start: caret - m[1].length - 1 };
}

export function createMentionChip(target: { id: string; name: string }): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.contentEditable = 'false';
  chip.dataset.mentionId = target.id;
  chip.dataset.mentionName = target.name;
  chip.className = 'mx-1 inline-flex max-w-full items-center rounded bg-accent-blue px-1 align-baseline text-white';
  chip.title = target.id;
  chip.textContent = `@${target.name}`;
  return chip;
}

export function serializeEditor(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof HTMLBRElement) return '\n';
  if (node instanceof HTMLElement && node.dataset.mentionId && node.dataset.mentionName) {
    return mentionToken({ id: node.dataset.mentionId, name: node.dataset.mentionName });
  }
  return [...node.childNodes].map(serializeEditor).join('');
}

export function renderSerializedEditor(root: HTMLElement, text: string): void {
  root.textContent = '';
  let cursor = 0;
  for (const token of parseMentionTokens(text)) {
    if (token.start > cursor) root.append(document.createTextNode(text.slice(cursor, token.start)));
    root.append(createMentionChip(token));
    cursor = token.end;
  }
  if (cursor < text.length) root.append(document.createTextNode(text.slice(cursor)));
}

function textLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').length;
  if (node instanceof HTMLElement && node.dataset.mentionName) return node.textContent?.length ?? 0;
  return [...node.childNodes].reduce((sum, child) => sum + textLength(child), 0);
}

export function domPointAt(root: Node, offset: number): { node: Node; offset: number } {
  let remaining = offset;
  for (const child of [...root.childNodes]) {
    const len = textLength(child);
    if (remaining > len) {
      remaining -= len;
      continue;
    }
    if (child.nodeType === Node.TEXT_NODE) return { node: child, offset: Math.min(remaining, len) };
    if (child instanceof HTMLElement && child.dataset.mentionName) {
      const index = [...root.childNodes].indexOf(child);
      return { node: root, offset: remaining <= 0 ? index : index + 1 };
    }
    return domPointAt(child, remaining);
  }
  return { node: root, offset: root.childNodes.length };
}

export function textBeforeCaret(root: HTMLElement): string {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return '';
  const range = selection.getRangeAt(0);
  const before = range.cloneRange();
  before.selectNodeContents(root);
  before.setEnd(range.endContainer, range.endOffset);
  return before.toString();
}

export function insertPlainText(text: string): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}
