// Pure helpers for ACP document sync: track the editor's open documents and render them as ambient
// context for the model. Kept side-effect-free and separate from connection.ts so they're unit-testable.

import type { Range } from '@agentclientprotocol/sdk';

export interface OpenDoc {
  text: string;
  version: number;
  languageId?: string;
}

// Total chars of open-document content folded into the prompt — bounds context blow-up when many or
// large files are open.
const OPEN_DOCS_BUDGET = 12_000;

/** String offset of an LSP position (utf-16). Scans to the start of `line` via `\n` boundaries, then
 * adds `character` — correct for both LF and CRLF, since `character` excludes the line terminator
 * (so we must NOT count a trailing `\r` as line content, which a `split('\n')` approach would). */
function offsetAt(text: string, pos: { line: number; character: number }): number {
  let i = 0;
  for (let line = 0; line < pos.line; line++) {
    const nl = text.indexOf('\n', i);
    if (nl === -1) return text.length;
    i = nl + 1;
  }
  return Math.min(i + pos.character, text.length);
}

/** Apply one LSP incremental edit (utf-16 positions) to `text`. */
export function applyRangeEdit(text: string, range: Range, newText: string): string {
  return text.slice(0, offsetAt(text, range.start)) + newText + text.slice(offsetAt(text, range.end));
}

/** Render the editor's open documents as a prompt section (focused file first), so the model knows
 * what the user is looking at. Returns undefined when nothing is open. */
export function renderOpenDocs(openDocs: Map<string, OpenDoc>, focusedUri?: string): string | undefined {
  if (openDocs.size === 0) return undefined;
  const uris = [...openDocs.keys()].sort((a, b) => (a === focusedUri ? -1 : b === focusedUri ? 1 : 0));
  const parts = ['The user has these documents open in their editor (live contents):'];
  let budget = OPEN_DOCS_BUDGET;
  for (const uri of uris) {
    const doc = openDocs.get(uri);
    if (!doc) continue;
    const tag = uri === focusedUri ? ' (focused)' : '';
    if (budget <= 0) {
      parts.push(`\n## ${uri}${tag} — [omitted: context budget reached]`);
      continue;
    }
    const body = doc.text.length > budget ? `${doc.text.slice(0, budget)}\n…[truncated]` : doc.text;
    budget -= body.length;
    parts.push(`\n## ${uri}${tag}\n\`\`\`${doc.languageId ?? ''}\n${body}\n\`\`\``);
  }
  return parts.join('\n');
}
