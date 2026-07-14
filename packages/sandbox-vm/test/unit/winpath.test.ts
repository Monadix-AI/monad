import { expect, test } from 'bun:test';

import { isWindowsAbsPath, toGuestPath, translateArgvPaths } from '../../src/winpath.ts';

test('windows drive paths translate to /mnt/<drive>', () => {
  expect(toGuestPath('C:\\Users\\zeke\\proj')).toBe('/mnt/c/Users/zeke/proj');
  expect(toGuestPath('D:/data/repo')).toBe('/mnt/d/data/repo');
  expect(toGuestPath('c:\\lower')).toBe('/mnt/c/lower');
});

test('drive roots and trailing slashes normalize', () => {
  expect(toGuestPath('C:\\')).toBe('/mnt/c');
  expect(toGuestPath('C:\\proj\\')).toBe('/mnt/c/proj');
  expect(toGuestPath('C:\\a\\\\b')).toBe('/mnt/c/a/b');
});

test('POSIX paths pass through unchanged (idempotent for mac/linux callers)', () => {
  expect(toGuestPath('/Users/zeke/proj')).toBe('/Users/zeke/proj');
  expect(toGuestPath('/mnt/c/already')).toBe('/mnt/c/already');
});

test('UNC paths are rejected (no drive letter to map)', () => {
  expect(() => toGuestPath('\\\\server\\share\\x')).toThrow('UNC');
});

test('translateArgvPaths rewrites only whole drive-path tokens, leaves the rest verbatim', () => {
  expect(translateArgvPaths(['cat', 'C:\\Users\\z\\f'])).toEqual(['cat', '/mnt/c/Users/z/f']);
  // a token that only embeds a path (not a whole drive path) is left alone — can't assume it's a path
  expect(translateArgvPaths(['tool', '--out=C:\\x', 'literal'])).toEqual(['tool', '--out=C:\\x', 'literal']);
  // POSIX/relative argv is identity
  expect(translateArgvPaths(['ls', '-la', '/tmp'])).toEqual(['ls', '-la', '/tmp']);
});

test('isWindowsAbsPath', () => {
  expect(isWindowsAbsPath('C:\\x')).toBe(true);
  expect(isWindowsAbsPath('c:/x')).toBe(true);
  expect(isWindowsAbsPath('/usr/bin')).toBe(false);
  expect(isWindowsAbsPath('relative\\path')).toBe(false);
});
