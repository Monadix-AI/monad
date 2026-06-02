import type { SessionId } from '@monad/protocol';
import type { ToolContext } from '#/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createAcpDelegateTool } from '#/services/delegation/acp-delegate.ts';

const fixture = resolve(import.meta.dir, '../fixtures/mock-acp-agent.ts');

function fakeCtx(sandboxRoots?: string[], progress?: string[]): ToolContext {
  return {
    sessionId: 'ses_100000000000' as SessionId,
    toolCallId: 'tc_1',
    sandboxRoots,
    signal: new AbortController().signal,
    reportProgress: (output: string) => progress?.push(output),
    log: () => {}
  } as unknown as ToolContext;
}

test('the sub-agent reads files through monad-served fs scoped to the session sandbox', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-acpdel-'));
  try {
    await writeFile(join(dir, 'note.txt'), 'served-by-monad');
    const tool = createAcpDelegateTool({
      agents: [{ name: 'mock', command: 'bun', args: [fixture], enabled: true, osSandbox: false, forwardMcp: false }]
    });
    const result = await tool.run({ agent: 'mock', instruction: `read ${join(dir, 'note.txt')}` }, fakeCtx([dir]));
    expect(result.metadata.text).toBe('read: served-by-monad');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the sub-agent runs shell through monad-served terminal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-acpterm-'));
  try {
    const tool = createAcpDelegateTool({
      agents: [{ name: 'mock', command: 'bun', args: [fixture], enabled: true, osSandbox: false, forwardMcp: false }]
    });
    const result = await tool.run({ agent: 'mock', instruction: 'term printf monad-term-ok' }, fakeCtx([dir]));
    expect(result.metadata.text).toBe('term: monad-term-ok');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
