import type { HookEvent, HookInput } from '@monad/protocol';
import type { HookDefinition } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';
import { createLogger } from '@monad/logger';

import { createHookRunner, type HookConfig, type HookRunRecord } from '#/hooks/runner.ts';

const log = createLogger('hooks-test');

function runner(config: HookConfig, atomHooks: Map<HookEvent, HookDefinition[]> = new Map()) {
  return createHookRunner({ config, atomHooks, cwd: process.cwd(), log });
}

function input(event: HookEvent, extra: Partial<HookInput> = {}): HookInput {
  return { event, sessionId: 'ses_test00000000', cwd: process.cwd(), timestamp: new Date().toISOString(), ...extra };
}

test('no configured hooks → zero-cost pass-through', async () => {
  const d = await runner({}).run(input('BeforeTurn', { prompt: 'hi' }));
  expect(d.blocked).toBe(false);
  expect(d.effectivePrompt).toBe('hi');
});

test('command hook exit 2 → blocked with stderr reason', async () => {
  const d = await runner({
    BeforeTool: [{ hooks: [{ command: 'echo "no writes" >&2; exit 2' }] }]
  }).run(input('BeforeTool', { toolName: 'file_write', toolInput: {} }));
  expect(d.blocked).toBe(true);
  expect(d.reason).toBe('no writes');
});

test('atom hook injects additionalContext', async () => {
  const hooks = new Map<HookEvent, HookDefinition[]>([
    ['BeforeTurn', [{ event: 'BeforeTurn', handler: () => ({ additionalContext: 'remember X' }) }]]
  ]);
  const d = await runner({}, hooks).run(input('BeforeTurn', { prompt: 'hi' }));
  expect(d.additionalContext).toEqual(['remember X']);
});

test('command-hook mutations chain (second sees the first)', async () => {
  const d = await runner({
    BeforeTurn: [
      { hooks: [{ command: `echo '{"mutatedPrompt":"step1"}'` }] },
      { hooks: [{ command: `grep -q '"prompt":"step1"' && echo '{"mutatedPrompt":"step1+step2"}'` }] }
    ]
  }).run(input('BeforeTurn', { prompt: 'orig' }));
  expect(d.effectivePrompt).toBe('step1+step2');
});

test('BeforeTool ask → routes to gate (ask flag set, not blocked)', async () => {
  const hooks = new Map<HookEvent, HookDefinition[]>([
    ['BeforeTool', [{ event: 'BeforeTool', handler: () => ({ decision: 'ask' as const }) }]]
  ]);
  const d = await runner({}, hooks).run(input('BeforeTool', { toolName: 'email_send', toolInput: {} }));
  expect(d.ask).toBe(true);
  expect(d.blocked).toBe(false);
});

test('AfterTool rewrites the tool result', async () => {
  const hooks = new Map<HookEvent, HookDefinition[]>([
    ['AfterTool', [{ event: 'AfterTool', handler: () => ({ updatedToolOutput: 'REDACTED' }) }]]
  ]);
  const d = await runner({}, hooks).run(input('AfterTool', { toolName: 'process_exec', toolResult: 'secret token' }));
  expect(d.effectiveToolOutput).toBe('REDACTED');
});

test('timeout → hook killed and treated as allow', async () => {
  const d = await runner({
    BeforeTurn: [{ hooks: [{ command: 'sleep 0.1', timeoutMs: 50 }] }]
  }).run(input('BeforeTurn', { prompt: 'hi' }));
  expect(d.blocked).toBe(false);
});

test('a throwing atom hook and a non-2 exit are isolated (not blocked)', async () => {
  const hooks = new Map<HookEvent, HookDefinition[]>([
    [
      'BeforeTurn',
      [
        {
          event: 'BeforeTurn',
          handler: () => {
            throw new Error('boom');
          }
        }
      ]
    ]
  ]);
  const d = await runner({ BeforeTurn: [{ hooks: [{ command: 'exit 1' }] }] }, hooks).run(
    input('BeforeTurn', { prompt: 'hi' })
  );
  expect(d.blocked).toBe(false);
});

test('matcher filters tool events by tool name', async () => {
  const cfg: HookConfig = {
    BeforeTool: [{ matcher: '^file_write$', hooks: [{ command: 'exit 2' }] }]
  };
  const allowed = await runner(cfg).run(input('BeforeTool', { toolName: 'file_read', toolInput: {} }));
  expect(allowed.blocked).toBe(false);
  const blocked = await runner(cfg).run(input('BeforeTool', { toolName: 'file_write', toolInput: {} }));
  expect(blocked.blocked).toBe(true);
});

test('SessionStart context is delivered to the first BeforeTurn, then cleared', async () => {
  const r = runner({ SessionStart: [{ hooks: [{ command: `echo '{"additionalContext":"boot ctx"}'` }] }] });
  const start = await r.run(input('SessionStart'));
  expect(start.additionalContext).toEqual(['boot ctx']);
  const first = await r.run(input('BeforeTurn', { prompt: 'hi' }));
  expect(first.additionalContext).toContain('boot ctx');
  const second = await r.run(input('BeforeTurn', { prompt: 'again' }));
  expect(second.additionalContext).not.toContain('boot ctx');
});

test('Stop continueWork surfaces on the decision', async () => {
  const hooks = new Map<HookEvent, HookDefinition[]>([
    ['AfterTurn', [{ event: 'AfterTurn', handler: () => ({ continueWork: { reason: 'run the tests first' } }) }]]
  ]);
  const d = await runner({}, hooks).run(input('AfterTurn', { reason: 'completed' }));
  expect(d.continueWork?.reason).toBe('run the tests first');
});

test('command-hook config is read per call (supports hot-reload)', async () => {
  let cfg: HookConfig = {};
  const r = createHookRunner({ config: () => cfg, atomHooks: new Map(), cwd: process.cwd(), log });
  expect((await r.run(input('BeforeTool', { toolName: 'file_write', toolInput: {} }))).blocked).toBe(false);
  cfg = { BeforeTool: [{ hooks: [{ command: 'exit 2' }] }] };
  expect((await r.run(input('BeforeTool', { toolName: 'file_write', toolInput: {} }))).blocked).toBe(true);
});

test('onError:deny — a timed-out command hook fails closed (blocks)', async () => {
  const d = await runner({
    BeforeTool: [{ hooks: [{ command: 'sleep 0.1', timeoutMs: 50, onError: 'deny' }] }]
  }).run(input('BeforeTool', { toolName: 'file_write', toolInput: {} }));
  expect(d.blocked).toBe(true);
});

test('onError:deny — a throwing atom hook fails closed (blocks)', async () => {
  const hooks = new Map<HookEvent, HookDefinition[]>([
    [
      'BeforeTool',
      [
        {
          event: 'BeforeTool',
          onError: 'deny',
          handler: () => {
            throw new Error('boom');
          }
        }
      ]
    ]
  ]);
  const d = await runner({}, hooks).run(input('BeforeTool', { toolName: 'file_write', toolInput: {} }));
  expect(d.blocked).toBe(true);
});

test('onError defaults to allow — a non-2 exit still skips (fail-open)', async () => {
  const d = await runner({
    BeforeTool: [{ hooks: [{ command: 'exit 1' }] }]
  }).run(input('BeforeTool', { toolName: 'file_write', toolInput: {} }));
  expect(d.blocked).toBe(false);
});

test('identical command specs are deduped (run once per event)', async () => {
  const records: HookRunRecord[] = [];
  const r = createHookRunner({
    config: {
      BeforeTool: [
        { matcher: '.*', hooks: [{ command: 'exit 0' }] },
        { matcher: '^file_write$', hooks: [{ command: 'exit 0' }] }
      ]
    },
    atomHooks: new Map(),
    cwd: process.cwd(),
    log,
    record: (e) => records.push(e)
  });
  await r.run(input('BeforeTool', { toolName: 'file_write', toolInput: {} }));
  expect(records.filter((e) => e.source === 'command').length).toBe(1);
});

test('policy command hooks run before user hooks and a policy deny wins', async () => {
  const r = createHookRunner({
    config: { BeforeTool: [{ hooks: [{ command: 'exit 0' }] }] },
    policy: { BeforeTool: [{ hooks: [{ command: 'echo "org policy" >&2; exit 2' }] }] },
    atomHooks: new Map(),
    cwd: process.cwd(),
    log
  });
  const d = await r.run(input('BeforeTool', { toolName: 'file_write', toolInput: {} }));
  expect(d.blocked).toBe(true);
  expect(d.reason).toBe('org policy');
});

test('record fires per executed hook with outcome + duration', async () => {
  const records: HookRunRecord[] = [];
  const r = createHookRunner({
    config: {},
    atomHooks: new Map<HookEvent, HookDefinition[]>([
      ['BeforeTool', [{ event: 'BeforeTool', handler: () => ({ decision: 'deny', reason: 'no' }) }]]
    ]),
    cwd: process.cwd(),
    log,
    record: (e) => records.push(e)
  });
  await r.run(input('BeforeTool', { toolName: 'file_write', toolInput: {} }));
  expect(records).toHaveLength(1);
  expect(records[0]?.outcome).toBe('deny');
  expect(typeof records[0]?.durationMs).toBe('number');
});

test('observe-only events (AfterCompact) aggregate context from concurrent hooks', async () => {
  const hooks = new Map<HookEvent, HookDefinition[]>([
    [
      'AfterCompact',
      [
        { event: 'AfterCompact', handler: () => ({ additionalContext: 'a' }) },
        { event: 'AfterCompact', handler: () => ({ additionalContext: 'b' }) }
      ]
    ]
  ]);
  const d = await runner({}, hooks).run(input('AfterCompact'));
  expect(d.additionalContext.sort()).toEqual(['a', 'b']);
});

test('AfterSubagent hook can rewrite the subagent result via mutatedText', async () => {
  const hooks = new Map<HookEvent, HookDefinition[]>([
    ['AfterSubagent', [{ event: 'AfterSubagent', handler: () => ({ mutatedText: 'REDACTED' }) }]]
  ]);
  const d = await runner({}, hooks).run(
    input('AfterSubagent', { subagentName: 'researcher', subagentResult: 'secret' })
  );
  expect(d.effectiveText).toBe('REDACTED');
});

test('AfterSubagent mutatedText chains serially — a later hook sees the prior rewrite', async () => {
  const seen: (string | undefined)[] = [];
  const hooks = new Map<HookEvent, HookDefinition[]>([
    [
      'AfterSubagent',
      [
        {
          event: 'AfterSubagent',
          handler: (i) => {
            seen.push(i.subagentResult);
            return { mutatedText: 'REDACTED' };
          }
        },
        {
          event: 'AfterSubagent',
          handler: (i) => {
            seen.push(i.subagentResult);
            return { mutatedText: `${i.subagentResult} [annotated]` };
          }
        }
      ]
    ]
  ]);
  const d = await runner({}, hooks).run(input('AfterSubagent', { subagentName: 'r', subagentResult: 'secret' }));
  expect(seen).toEqual(['secret', 'REDACTED']); // second hook saw the first's rewrite, not the original
  expect(d.effectiveText).toBe('REDACTED [annotated]');
});

test('first deny short-circuits later hooks', async () => {
  let secondRan = false;
  const hooks = new Map<HookEvent, HookDefinition[]>([
    [
      'BeforeTurn',
      [
        { event: 'BeforeTurn', handler: () => ({ decision: 'deny' as const, reason: 'stop' }) },
        {
          event: 'BeforeTurn',
          handler: () => {
            secondRan = true;
          }
        }
      ]
    ]
  ]);
  const d = await runner({}, hooks).run(input('BeforeTurn', { prompt: 'hi' }));
  expect(d.blocked).toBe(true);
  expect(secondRan).toBe(false);
});
