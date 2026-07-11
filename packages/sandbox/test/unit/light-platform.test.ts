import { expect, test } from 'bun:test';

import { lightSandboxLaunchers as darwin } from '../../src/light-platform.darwin.ts';
import { lightSandboxLaunchers as linux } from '../../src/light-platform.linux.ts';
import { lightSandboxLaunchers as all } from '../../src/light-platform.ts';
import { lightSandboxLaunchers as windows } from '../../src/light-platform.windows.ts';

const kinds = (launchers: typeof all): string[] => launchers.map(({ kind }) => kind);

test('development includes every light launcher in selection order', () => {
  expect(kinds(all)).toEqual(['seatbelt', 'bwrap', 'landlock', 'appcontainer', 'lowintegrity']);
});

test('Darwin includes only Seatbelt', () => {
  expect(kinds(darwin)).toEqual(['seatbelt']);
});

test('Linux includes bwrap then Landlock', () => {
  expect(kinds(linux)).toEqual(['bwrap', 'landlock']);
});

test('Windows includes AppContainer then Low Integrity', () => {
  expect(kinds(windows)).toEqual(['appcontainer', 'lowintegrity']);
});
