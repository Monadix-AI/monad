import { expect, test } from 'bun:test';

import { hostSandboxPlatform as darwinPlatform } from '../../src/sandbox-platform.darwin.ts';
import { hostSandboxPlatform as linuxPlatform } from '../../src/sandbox-platform.linux.ts';
import { hostSandboxPlatform as allPlatform } from '../../src/sandbox-platform.ts';
import { hostSandboxPlatform as windowsPlatform } from '../../src/sandbox-platform.windows.ts';

const kinds = (launchers: typeof allPlatform.launchers): string[] => launchers.map(({ kind }) => kind);

test('development includes every host launcher in selection order', () => {
  expect(kinds(allPlatform.launchers)).toEqual(['seatbelt', 'bwrap', 'landlock', 'appcontainer', 'lowintegrity']);
});

test('Darwin includes only Seatbelt', () => {
  expect(kinds(darwinPlatform.launchers)).toEqual(['seatbelt']);
});

test('Linux includes bwrap then Landlock', () => {
  expect(kinds(linuxPlatform.launchers)).toEqual(['bwrap', 'landlock']);
});

test('Windows includes AppContainer then Low Integrity', () => {
  expect(kinds(windowsPlatform.launchers)).toEqual(['appcontainer', 'lowintegrity']);
});

test('every platform seam exposes the shared host lifecycle contract', () => {
  for (const platform of [allPlatform, darwinPlatform, linuxPlatform, windowsPlatform]) {
    expect(platform.prepareHost).toBeFunction();
    expect(platform.disposeHost).toBeFunction();
  }
});
