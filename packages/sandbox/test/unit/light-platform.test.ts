import { expect, test } from 'bun:test';

import { lightSandboxPlatform as darwinPlatform } from '../../src/light-platform.darwin.ts';
import { lightSandboxPlatform as linuxPlatform } from '../../src/light-platform.linux.ts';
import { lightSandboxPlatform as allPlatform } from '../../src/light-platform.ts';
import { lightSandboxPlatform as windowsPlatform } from '../../src/light-platform.windows.ts';

const kinds = (launchers: typeof allPlatform.launchers): string[] => launchers.map(({ kind }) => kind);

test('development includes every light launcher in selection order', () => {
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

test('every platform seam exposes the shared cleanup contract', () => {
  for (const platform of [allPlatform, darwinPlatform, linuxPlatform, windowsPlatform]) {
    expect(platform.sweepOrphanAppContainerProfiles).toBeFunction();
  }
});
