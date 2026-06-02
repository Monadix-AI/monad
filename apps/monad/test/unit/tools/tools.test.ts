import { expect, test } from 'bun:test';

import { builtinTools, emailSendTool } from '#/capabilities/tools';

test('built-in tools have unique names', () => {
  const names = builtinTools.map((t) => t.name);
  expect(new Set(names).size).toBe(names.length);
});

test('email_send is flagged high-risk', () => {
  expect(emailSendTool.highRisk).toBe(true);
});

test('built-in input schemas reject malformed input', () => {
  expect(emailSendTool.inputSchema?.safeParse({ to: 'not-an-array', subject: 'x', body: 'y' }).success).toBe(false);
  expect(emailSendTool.inputSchema?.safeParse({ to: ['a@b.c'], subject: 'x', body: 'y' }).success).toBe(true);
});
