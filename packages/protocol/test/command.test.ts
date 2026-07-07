import { expect, test } from 'bun:test';

import { commandItemSchema, commandsListQuerySchema, parseSlashCommand } from '../src/command.ts';

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

test('parseSlashCommand trims surrounding whitespace but only accepts commands at the start', () => {
  expect(parseSlashCommand(' /reset ')).toEqual({ name: 'reset', args: '' });
  expect(parseSlashCommand('/model gpt-x')).toEqual({ name: 'model', args: 'gpt-x' });
  expect(parseSlashCommand('hello /reset')).toBeNull();
  expect(parseSlashCommand('正文\n/reset')).toBeNull();
});

test('commandsListQuerySchema accepts optional filters', () => {
  expect(commandsListQuerySchema.parse({})).toEqual({});
  expect(commandsListQuerySchema.parse({ filter: 'all' })).toEqual({ filter: 'all' });
  expect(commandsListQuerySchema.parse({ filter: 'disabled' })).toEqual({ filter: 'disabled' });
});

test('commandItemSchema supports structured args and subcommands', () => {
  expect(
    commandItemSchema.parse({
      id: 'memory',
      name: 'Memory',
      type: 'action',
      source: 'builtin',
      group: 'Memory',
      description: 'Manage memory',
      aliases: [],
      enabled: true,
      subcommands: [
        {
          id: 'consolidate',
          name: 'Consolidate',
          description: 'Consolidate memory',
          shortcut: 'consolidate',
          args: [{ name: 'level', type: 'number', required: false, placeholder: '[level]' }]
        }
      ]
    })
  ).toMatchObject({
    group: 'Memory',
    subcommands: [
      {
        id: 'consolidate',
        shortcut: 'consolidate',
        args: [{ name: 'level', type: 'number' }]
      }
    ]
  });
});
