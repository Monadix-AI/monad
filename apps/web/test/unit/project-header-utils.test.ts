import { expect, test } from 'bun:test';

import {
  fileManagerLabel,
  terminalLabel,
  workdirLabel
} from '../../src/features/workplace/project-shell/project-header-utils';

test('workdir label uses the last path segment', () => {
  expect(workdirLabel('/Users/zeke/Projects/monad/', 'Set folder')).toBe('monad');
  expect(workdirLabel('C:\\Users\\zeke\\monad', 'Set folder')).toBe('monad');
  expect(workdirLabel(undefined, 'Set folder')).toBe('Set folder');
});

test('project header platform action labels match the host platform', () => {
  expect(fileManagerLabel('MacIntel')).toBe('Show in Finder');
  expect(fileManagerLabel('Win32')).toBe('Show in Explorer');
  expect(fileManagerLabel('Linux x86_64')).toBe('Show in file manager');
  expect(terminalLabel('MacIntel')).toBe('Open in Terminal');
  expect(terminalLabel('Linux x86_64')).toBe('Open in terminal');
});
