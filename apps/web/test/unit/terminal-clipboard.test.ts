import { expect, test } from 'bun:test';

import { terminalClipboardText } from '../../src/features/workplace/cli/terminal-clipboard.ts';

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
