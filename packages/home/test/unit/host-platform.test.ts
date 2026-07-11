import { expect, test } from 'bun:test';

import { hostPlatformModule as darwinModule } from '../../src/host-platform.darwin.ts';
import { hostPlatformModule as linuxModule } from '../../src/host-platform.linux.ts';
import { hostPlatformModule as windowsModule } from '../../src/host-platform.windows.ts';

const darwin = darwinModule.current;
const linux = linuxModule.current;
const windows = windowsModule.current;

test('Darwin host commands use osascript and open', () => {
  const [picker] = darwin.directoryPickerSpecs({ prompt: 'Pick', defaultPath: '/tmp/work' });
  expect(picker?.argv.slice(0, 3)).toEqual(['osascript', '-e', expect.any(String)]);
  expect(picker?.argv.slice(-2)).toEqual(['Pick', '/tmp/work']);
  expect(darwin.openUrlCommand('https://example.com').argv).toEqual(['open', 'https://example.com']);
  expect(darwin.openPathCommands('/tmp/a', 'open')[0]?.argv).toEqual(['open', '/tmp/a']);
  expect(darwin.openPathCommands('/tmp/a', 'reveal')[0]?.argv).toEqual(['open', '-R', '/tmp/a']);
});

test('Linux host commands use desktop opener fallbacks', () => {
  expect(linux.directoryPickerSpecs({ prompt: 'Pick' }).map(({ argv }) => argv[0])).toEqual(['zenity', 'kdialog']);
  expect(linux.openUrlCommand('https://example.com').argv).toEqual(['xdg-open', 'https://example.com']);
  expect(linux.openPathCommands('/tmp/a', 'reveal')[0]?.argv).toEqual(['xdg-open', '/tmp/a']);
});

test('Windows host commands carry untrusted values outside static PowerShell source', () => {
  const [picker] = windows.directoryPickerSpecs({ prompt: 'Pick & run', defaultPath: 'C:\\work' });
  expect(picker?.env).toMatchObject({ MONAD_PICK_PROMPT: 'Pick & run', MONAD_PICK_DEFAULT: 'C:\\work' });
  const url = windows.openUrlCommand('https://example.com/?x=1&calc');
  expect(url.argv).toEqual([
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Start-Process -FilePath $env:MONAD_OPEN_URL'
  ]);
  expect(url.env).toEqual({ MONAD_OPEN_URL: 'https://example.com/?x=1&calc' });
  expect(windows.openPathCommands('C:\\work\\a.txt', 'reveal')[0]?.argv).toEqual([
    'explorer.exe',
    '/select,',
    'C:\\work\\a.txt'
  ]);
  expect(windows.openPathCommands('C:\\work', 'open')[0]?.env).toEqual({ MONAD_OPEN_PATH: 'C:\\work' });
});
