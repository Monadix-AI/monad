import { expect, test } from 'bun:test';

import { humanReadableCliOutput } from '../../features/workplace/cli/cli-output.ts';

test('humanReadableCliOutput strips terminal color and cursor controls', () => {
  expect(
    humanReadableCliOutput('\u001b[20;2H\u001b[0m\u001b[49m\u001b[K\u001b[1m›\u001b[22m hi\u001b[?25h\u001b[?2026l')
  ).toBe('› hi');
});

test('humanReadableCliOutput strips OSC and device-query escapes', () => {
  expect(
    humanReadableCliOutput('\u001b]0;title\u0007\u001b[38;2;255;193;7mNew MCP server found\u001b[39m\u001b[>0q\u001b[c')
  ).toBe('New MCP server found');
});

test('humanReadableCliOutput applies carriage-return line updates', () => {
  expect(humanReadableCliOutput('loading 10%\rloading 90%\rdone')).toBe('done');
});

test('humanReadableCliOutput handles backspace updates', () => {
  expect(humanReadableCliOutput('abc\b\bXY')).toBe('aXY');
});
