// todo — in-session task list keyed by ctx.sessionId. Ephemeral by design: structures the
// model's plan within a session, not durable project state. No sandbox/gate concerns.

import type { Tool } from '../types.ts';

import { z } from 'zod';

import { toolResult } from '../types.ts';

const todoStatusSchema = z.enum(['pending', 'in_progress', 'completed']);

const todoItemSchema = z.object({
  content: z.string().min(1),
  status: todoStatusSchema,
  activeForm: z.string().optional() // present-continuous form shown while in_progress
});
export type TodoItem = z.infer<typeof todoItemSchema>;

// A session's list is replaced wholesale on each write — the model always sends the full desired state.
const sessions = new Map<string, TodoItem[]>();

const todoWriteInput = z.object({ todos: z.array(todoItemSchema) });

export const todoWriteTool: Tool<z.infer<typeof todoWriteInput>, { todos: TodoItem[] }> = {
  name: 'todo_write',
  description:
    'Replace the current session task list. Send the FULL list each time; exactly one item should be in_progress while working.',
  scopes: [{ resource: 'todo' }],
  inputSchema: todoWriteInput,
  run: async ({ todos }, ctx) => {
    sessions.set(ctx.sessionId, todos);
    return toolResult({ todos });
  }
};

export const todoReadTool: Tool<Record<string, never>, { todos: TodoItem[] }> = {
  name: 'todo_read',
  description: 'Read the current session task list.',
  scopes: [{ resource: 'todo' }],
  inputSchema: z.object({}),
  run: async (_input, ctx) => toolResult({ todos: sessions.get(ctx.sessionId) ?? [] })
};

/** Forget a session's list (call on session end). */
export function clearTodos(sessionId: string): void {
  sessions.delete(sessionId);
}

const todoTools: Tool[] = [todoWriteTool as Tool, todoReadTool as Tool];

import type { ToolModule } from './contract.ts';
// Uniform module entry. Static module — no boot deps.
export const register: ToolModule = () => todoTools;
