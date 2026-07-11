import type { ToolContext } from '#/capabilities/tools/types.ts';

import { afterEach, expect, test } from 'bun:test';

import { clearProcesses, processControlTool, shellExecTool } from '#/capabilities/tools';
import { SESSION_DELETE_BACKEND_GRACE_MS } from '#/handlers/session/handlers/lifecycle/index.ts';
import { buildHandlers, mockModel } from '../../helpers.ts';

// Guards the lifecycle wiring: clearProcessesForSession must be CALLED from delete()/reset(),
// not merely defined. (It was silently dropped once with no test to catch it.)

afterEach(() => clearProcesses());

const procCtx = (sessionId: string): ToolContext => ({ sessionId, sandboxRoots: undefined, log: () => {} });
const longRunning = { command: 'sleep 30' };

async function startProcess(sessionId: string) {
  const result = (await shellExecTool.run({ ...longRunning, mode: 'background' }, procCtx(sessionId))).metadata;
  if (result.status !== 'running') throw new Error('shell_exec did not start a background process');
  return result.processId;
}

test('session reset kills the session’s background processes', async () => {
  const d = buildHandlers(mockModel(['ok']));
  const { sessionId } = await d.session.create({ title: 't' });
  const id = await startProcess(sessionId);
  const listed = (await processControlTool.run({ action: 'list' }, procCtx(sessionId))).metadata;
  if (!('processes' in listed)) throw new Error('process_control list did not return a process list');
  expect(listed.processes.some((p) => p.id === id)).toBe(true);

  await d.session.reset({ id: sessionId });

  await expect(processControlTool.run({ action: 'logs', id }, procCtx(sessionId))).rejects.toThrow(/unknown process/);
});

test(
  'session delete kills the session’s background processes after the undo grace period',
  async () => {
    const d = buildHandlers(mockModel(['ok']));
    const { sessionId } = await d.session.create({ title: 't' });
    const id = await startProcess(sessionId);

    await d.session.delete({ id: sessionId });
    await Bun.sleep(SESSION_DELETE_BACKEND_GRACE_MS + 50);

    await expect(processControlTool.run({ action: 'logs', id }, procCtx(sessionId))).rejects.toThrow(/unknown process/);
  },
  SESSION_DELETE_BACKEND_GRACE_MS + 2_000
);
