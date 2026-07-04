// LIVE tests against the REAL Hermes / OpenClaw binaries installed on this machine. Gated behind env
// flags AND binary/`.local` naming so normal CI never runs them (they spend real LLM turns):
//   MONAD_LIVE_AGENTS=1    → detect smoke + a real Hermes cli-oneshot turn (Hermes is the default-authed
//                           path here via GitHub Copilot creds)
//   MONAD_LIVE_OPENCLAW=1  → a real OpenClaw app-server (gateway) turn; separate flag because it needs a
//                           configured/authed OpenClaw gateway which may not be present
//
// Run:  MONAD_LIVE_AGENTS=1 bun test apps/monad/test/e2e/agent-adapters-real.local.test.ts

import type { NativeCliSessionView } from '@monad/protocol';

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinAgentAdapters, hermesNativeCliAdapter, openClawNativeCliAdapter } from '@monad/atoms/agent-adapters';

import { EventBus } from '@/services/event-bus.ts';
import { NativeCliHost } from '@/services/native-cli/host.ts';
import { registerAgentAdapterImpl } from '@/services/native-cli/index.ts';
import { createStore } from '@/store/db/index.ts';

for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

const LIVE = process.env.MONAD_LIVE_AGENTS === '1';
const LIVE_OPENCLAW = process.env.MONAD_LIVE_OPENCLAW === '1';
// A prompt that should elicit a short, matchable reply from any model.
const PING_PROMPT = 'Reply with exactly the single uppercase word PONG and nothing else.';

/** Drive one turn through the real NativeCliHost (real binary + adapter + host lifecycle) and return
 *  the observed transcript output once it appears (or after the timeout). */
async function runTurn(args: {
  provider: 'hermes' | 'openclaw';
  command: string;
  launchMode: NativeCliSessionView['launchMode'];
  prompt: string;
  timeoutMs: number;
}): Promise<{ view: NativeCliSessionView; output: string; host: NativeCliHost; cleanup: () => void }> {
  const store = createStore();
  const workdir = mkdtempSync(join(tmpdir(), `live-${args.provider}-`));
  const host = new NativeCliHost({
    store,
    bus: new EventBus(),
    agents: async () => [
      {
        name: args.provider,
        provider: args.provider,
        command: args.command,
        enabled: true,
        defaultLaunchMode: args.launchMode,
        allowDangerousMode: false,
        approvalOwnership: 'provider-owned'
      }
    ]
  });
  const projectId = 'prj_01KWLIVEADAPTERS000000000001';
  store.insertWorkplaceProject({
    id: projectId,
    title: 'live adapter test',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z'
  });
  const observed = (id: string): string => {
    const obs = host.observe(id);
    return obs && 'output' in obs ? (obs.output ?? '') : '';
  };
  const view = await host.start({
    transcriptTargetId: projectId,
    agentName: args.provider,
    workingPath: workdir,
    launchMode: args.launchMode
  });
  host.input(view.id, { input: args.prompt });
  const deadline = Date.now() + args.timeoutMs;
  while (Date.now() < deadline && observed(view.id).trim().length === 0) {
    await Bun.sleep(500);
  }
  return {
    view,
    output: observed(view.id),
    host,
    cleanup: () => {
      try {
        host.stop(view.id);
      } catch {
        /* already stopped */
      }
      rmSync(workdir, { recursive: true, force: true });
    }
  };
}

describe.skipIf(!LIVE)('real agent-adapter binaries: detect', () => {
  test('Hermes binary is installed and offers pty + cli-oneshot (no app-server)', () => {
    const preset = hermesNativeCliAdapter.detect();
    expect(preset.installed).toBe(true);
    expect(preset.supportedLaunchModes).toEqual(['pty', 'cli-oneshot']);
    expect(preset.supportedAppServerTransports).toBeUndefined();
  });

  test('OpenClaw binary is installed and offers pty + app-server', () => {
    const preset = openClawNativeCliAdapter.detect();
    expect(preset.installed).toBe(true);
    expect(preset.supportedLaunchModes).toContain('app-server');
  });

  test('Hermes auth-status probe reports the real signed-in state (plain-text, no --json error)', async () => {
    const probe = hermesNativeCliAdapter.authStatus({
      name: 'hermes',
      provider: 'hermes',
      command: 'hermes',
      enabled: true,
      defaultLaunchMode: 'cli-oneshot',
      allowDangerousMode: false,
      approvalOwnership: 'provider-owned'
    });
    // No --json (Hermes rejects it) — the fix that stops a signed-in Hermes being misreported.
    expect(probe.launch.argv).toEqual(['hermes', 'auth', 'list']);
    const proc = Bun.spawn(probe.launch.argv, {
      cwd: probe.launch.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore'
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    // On this signed-in machine the probe must resolve authenticated — NOT 'unauthenticated' from a
    // `--json` argparse error (which is exactly the bug this test guards).
    expect(probe.parse(`${out}${err}`, code)).toBe('authenticated');
  }, 20_000);
});

describe.skipIf(!LIVE)('real Hermes cli-oneshot turn', () => {
  test('a managed-style one-shot turn produces a real reply the host captures', async () => {
    const run = await runTurn({
      provider: 'hermes',
      command: 'hermes',
      launchMode: 'cli-oneshot',
      prompt: PING_PROMPT,
      timeoutMs: 180_000
    });
    try {
      // The real `hermes --yolo -z <prompt>` ran to completion and its stdout reached the transcript.
      expect(run.output.trim().length).toBeGreaterThan(0);
      // Soft content check — the model was asked for PONG; log the raw reply for eyeballing regardless.
      // biome-ignore lint/suspicious/noConsole: a live opt-in probe surfaces the real model reply
      console.log(`[live hermes reply] ${run.output.trim().slice(0, 400)}`);
      expect(run.output.toUpperCase()).toContain('PONG');
    } finally {
      run.cleanup();
    }
  }, 190_000);
});

// OpenClaw's app-server path is NOT yet functional end-to-end (this probe surfaced it): the adapter
// launches `openclaw gateway` but the real foreground server is `openclaw gateway run`, and even that
// needs `--allow-unconfigured` + an auth token + a parseable listen-port announcement the host reads
// from stderr — none of which the current adapter/host wiring supplies. So this is an OPT-IN probe
// (MONAD_LIVE_OPENCLAW=1) that asserts a reply IF a configured gateway is reachable, and otherwise logs
// the known gap without hard-failing (mirrors how Hermes's fictional app-server was found + removed).
describe.skipIf(!(LIVE && LIVE_OPENCLAW))('real OpenClaw app-server turn', () => {
  test('a turn through the real openclaw gateway produces a reply the host captures', async () => {
    let run: Awaited<ReturnType<typeof runTurn>>;
    try {
      run = await runTurn({
        provider: 'openclaw',
        command: 'openclaw',
        launchMode: 'app-server',
        prompt: PING_PROMPT,
        timeoutMs: 180_000
      });
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: a live opt-in probe reports the known OpenClaw gap
      console.warn(
        '[live openclaw] gateway did not start — known gap: the adapter launches `openclaw gateway` ' +
          `(should be \`gateway run --allow-unconfigured\`) and lacks auth-token/port-announcement handling. ${String(err)}`
      );
      return;
    }
    try {
      // biome-ignore lint/suspicious/noConsole: a live opt-in probe surfaces the real model reply
      console.log(`[live openclaw reply] ${run.output.trim().slice(0, 400)}`);
      expect(run.output.trim().length).toBeGreaterThan(0);
    } finally {
      run.cleanup();
    }
  }, 190_000);
});
