import type { ToolContext } from '#/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';

import { clearTodos, type TodoItem, todoReadTool, todoWriteTool } from '#/capabilities/tools';

const ctx = (sessionId: string): ToolContext => ({ sessionId, sandboxRoots: undefined, log: () => {} });

const sample: TodoItem[] = [
  { content: 'first', status: 'in_progress', activeForm: 'doing first' },
  { content: 'second', status: 'pending' }
];

test('todo_write stores the list and todo_read returns it for the same session', async () => {
  await todoWriteTool.run({ todos: sample }, ctx('s1'));
  const out = await todoReadTool.run({}, ctx('s1'));
  expect(out.metadata.todos).toEqual(sample);
});

test('todo_read is empty for a session with no list', async () => {
  expect((await todoReadTool.run({}, ctx('empty'))).metadata.todos).toEqual([]);
});

test('todo lists are isolated per session', async () => {
  await todoWriteTool.run({ todos: [{ content: 'a', status: 'pending' }] }, ctx('sA'));
  await todoWriteTool.run({ todos: [{ content: 'b', status: 'completed' }] }, ctx('sB'));
  expect((await todoReadTool.run({}, ctx('sA'))).metadata.todos[0]?.content).toBe('a');
  expect((await todoReadTool.run({}, ctx('sB'))).metadata.todos[0]?.content).toBe('b');
});

test('todo_write replaces the whole list', async () => {
  await todoWriteTool.run({ todos: sample }, ctx('s2'));
  await todoWriteTool.run({ todos: [{ content: 'only', status: 'completed' }] }, ctx('s2'));
  expect((await todoReadTool.run({}, ctx('s2'))).metadata.todos).toEqual([{ content: 'only', status: 'completed' }]);
});

test('todo_write rejects an invalid status', () => {
  expect(todoWriteTool.inputSchema?.safeParse({ todos: [{ content: 'x', status: 'bogus' }] }).success).toBe(false);
});

test('clearTodos forgets a session list', async () => {
  await todoWriteTool.run({ todos: sample }, ctx('s3'));
  clearTodos('s3');
});
