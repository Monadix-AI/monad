import { expect, test } from 'bun:test';

import { terminalClipboardText, terminalSelectionText } from '../../src/features/workplace/cli/terminal-clipboard.ts';

test('terminalClipboardText reads browser plain text paste payloads', () => {
  const requested: string[] = [];
  const text = terminalClipboardText({
    getData(type) {
      requested.push(type);
      return type === 'text/plain' ? 'oauth-code-123' : '';
    }
  });

  expect({ text, requested }).toEqual({ text: 'oauth-code-123', requested: ['text/plain'] });
});

test('terminalClipboardText falls back to legacy text paste payloads', () => {
  const requested: string[] = [];
  const text = terminalClipboardText({
    getData(type) {
      requested.push(type);
      return type === 'text' ? 'legacy-code-456' : '';
    }
  });

  expect({ text, requested }).toEqual({ text: 'legacy-code-456', requested: ['text/plain', 'text'] });
});

test('terminalSelectionText removes visual soft-wrap boundaries from copied text', () => {
  const lines = [{ isWrapped: false }, { isWrapped: true }, { isWrapped: false }];

  const text = terminalSelectionText({
    buffer: {
      active: {
        getLine: (index: number) => lines[index],
        length: lines.length
      }
    },
    getSelection: () => 'alpha\nbeta\ngamma',
    getSelectionPosition: () => ({
      end: { x: 4, y: 2 },
      start: { x: 0, y: 0 }
    }),
    getViewportY: () => 0,
    rows: lines.length
  });

  expect(text).toBe('alphabeta\ngamma');
});
