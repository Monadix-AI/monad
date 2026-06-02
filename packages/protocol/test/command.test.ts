import { expect, test } from 'bun:test';

import { parseSlashCommand } from '../src/command.ts';

test('parseSlashCommand accepts addressable skill ids', () => {
  expect(parseSlashCommand('/global:summarize-changes')).toEqual({
    name: 'global:summarize-changes',
    args: ''
  });
  expect(parseSlashCommand('/atom-pack:monad-test:summarize-changes now')).toEqual({
    name: 'atom-pack:monad-test:summarize-changes',
    args: 'now'
  });
  expect(parseSlashCommand('/agent:default:summarize-changes')).toEqual({
    name: 'agent:default:summarize-changes',
    args: ''
  });
});

test('parseSlashCommand keeps existing dotted command ids', () => {
  expect(parseSlashCommand('/pack.command arg')).toEqual({ name: 'pack.command', args: 'arg' });
});
