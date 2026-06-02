import { expect, test } from 'bun:test';

import { guestArg, guestPath, shellQuote } from '../e2e/vm-fixture.ts';

test('guestArg translates a Windows path with spaces and quotes it once', () => {
  expect(guestArg('C:\\Users\\First Last\\work', 'win32')).toBe("'/mnt/c/Users/First Last/work'");
});

test('guestPath keeps POSIX paths unchanged', () => {
  expect(guestPath('/tmp/work', 'linux')).toBe('/tmp/work');
  expect(guestPath('/tmp/work', 'darwin')).toBe('/tmp/work');
});

test('shellQuote preserves apostrophes without permitting shell expansion', () => {
  expect(shellQuote("/tmp/a'b $HOME")).toBe("'/tmp/a'\\''b $HOME'");
});
