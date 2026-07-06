import type { ToolContext } from '@/capabilities/tools/types.ts';

import { afterEach, expect, test } from 'bun:test';

import { clearProcesses, processListTool, processLogsTool, processStartTool } from '@/capabilities/tools';
import { buildHandlers, mockModel } from '../../helpers.ts';

// Guards the lifecycle wiring: clearProcessesForSession must be CALLED from delete()/reset(),
// not merely defined. (It was silently dropped once with no test to catch it.)

afterEach(() => clearProcesses());

const procCtx = (sessionId: string): ToolContext => ({ sessionId, sandboxRoots: undefined, log: () => {} });
const longRunning = { command: 'sleep 30' };

test('session reset kills the session’s background processes', async () => {
  const d = buildHandlers(mockModel(['ok']));
  const { sessionId } = await d.session.create({ title: 't' });
  const { id } = (await processStartTool.run(longRunning, procCtx(sessionId))).metadata;
  expect((await processListTool.run({}, procCtx(sessionId))).metadata.processes.some((p) => p.id === id)).toBe(true);

  await d.session.reset({ id: sessionId });

  await expect(processLogsTool.run({ id }, procCtx(sessionId))).rejects.toThrow(/unknown process/);
});

test('session delete kills the session’s background processes', async () => {
  const d = buildHandlers(mockModel(['ok']));
  const { sessionId } = await d.session.create({ title: 't' });
  const { id } = (await processStartTool.run(longRunning, procCtx(sessionId))).metadata;

  await d.session.delete({ id: sessionId });

  await expect(processLogsTool.run({ id }, procCtx(sessionId))).rejects.toThrow(/unknown process/);
});
