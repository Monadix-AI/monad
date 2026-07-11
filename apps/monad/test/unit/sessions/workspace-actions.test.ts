import { expect, test } from 'bun:test';

import { workspaceActionCommands, workspaceActionLabel } from '#/handlers/session/workspace-actions.ts';

const cwd = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo';

test('file manager labels match the host platform vocabulary', () => {
  expect(workspaceActionLabel('show-in-file-manager', 'darwin')).toBe('Show in Finder');
  expect(workspaceActionLabel('show-in-file-manager', 'win32')).toBe('Show in Explorer');
  expect(workspaceActionLabel('show-in-file-manager', 'linux')).toBe('Show in file manager');
});

test('file manager commands are platform-specific', () => {
  expect(workspaceActionCommands('show-in-file-manager', cwd, 'darwin')[0]?.argv).toEqual(['open', '-R', cwd]);
  expect(workspaceActionCommands('show-in-file-manager', cwd, 'win32')[0]?.argv).toEqual([
    'explorer.exe',
    '/select,',
    cwd
  ]);
  expect(workspaceActionCommands('show-in-file-manager', cwd, 'linux')[0]?.argv).toEqual(['xdg-open', cwd]);
});

test('terminal commands preserve cwd as an argv or environment value', () => {
  expect(workspaceActionCommands('open-terminal', cwd, 'darwin')[0]?.argv).toEqual(['open', '-a', 'Terminal', cwd]);
  expect(workspaceActionCommands('open-terminal', cwd, 'win32')[0]?.argv).toEqual(['wt.exe', '-d', cwd]);
  expect(workspaceActionCommands('open-terminal', cwd, 'win32')[1]?.env?.MONAD_WORKDIR).toBe(cwd);
  expect(workspaceActionCommands('open-terminal', cwd, 'linux').map((command) => command.argv[0])).toEqual([
    'x-terminal-emulator',
    'gnome-terminal',
    'konsole',
    'xterm'
  ]);
});
