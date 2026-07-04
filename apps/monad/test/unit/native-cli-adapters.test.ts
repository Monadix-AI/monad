import type { NativeCliAgentView } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  builtinAgentAdapters,
  claudeCodeNativeCliAdapter,
  codexNativeCliAdapter,
  geminiNativeCliAdapter,
  hermesNativeCliAdapter,
  openClawNativeCliAdapter,
  qwenNativeCliAdapter
} from '@monad/atoms/agent-adapters';
import { parseNativeCliArgumentSupport } from '@monad/atoms/agent-adapters/argument-support';
import { normalizePtyInput } from '@monad/atoms/agent-adapters/pty';

import {
  buildNativeCliArgumentSupportProbe,
  buildNativeCliAuthLaunch,
  buildNativeCliAuthStatusLaunch,
  buildNativeCliLaunch,
  listNativeCliAgentModelOptions,
  listNativeCliAgentPresets,
  registerAgentAdapterImpl,
  resolveNativeCliLaunchCommand
} from '@/services/native-cli/index.ts';
import { killNativeCliProcess } from '@/services/native-cli/process.ts';
import { nativeCliOutputEventSchema } from '@/services/native-cli/types.ts';

// The native-CLI registry is populated at daemon boot via the gated atom-pack path; unit tests drive
// the builder/preset functions directly, so register the built-in adapters up front.
for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

const codexAgent: NativeCliAgentView = {
  name: 'codex',
  provider: 'codex',
  command: 'codex',
  enabled: true,
  defaultLaunchMode: 'pty',
  allowDangerousMode: false,
  approvalOwnership: 'provider-owned'
};

const claudeAgent: NativeCliAgentView = {
  name: 'claude-code',
  provider: 'claude-code',
  command: 'claude',
  enabled: true,
  defaultLaunchMode: 'pty',
  allowDangerousMode: false,
  approvalOwnership: 'provider-owned'
};

const geminiAgent: NativeCliAgentView = {
  name: 'gemini',
  provider: 'gemini',
  command: 'gemini',
  enabled: true,
  defaultLaunchMode: 'pty',
  allowDangerousMode: false,
  approvalOwnership: 'provider-owned'
};

const qwenAgent: NativeCliAgentView = {
  name: 'qwen',
  provider: 'qwen',
  command: 'qwen',
  enabled: true,
  defaultLaunchMode: 'pty',
  allowDangerousMode: false,
  approvalOwnership: 'provider-owned'
};

const openClawAgent: NativeCliAgentView = {
  name: 'openclaw',
  provider: 'openclaw',
  command: 'openclaw',
  enabled: true,
  defaultLaunchMode: 'pty',
  allowDangerousMode: false,
  approvalOwnership: 'provider-owned'
};

const hermesAgent: NativeCliAgentView = {
  name: 'hermes',
  provider: 'hermes',
  command: 'hermes',
  enabled: true,
  defaultLaunchMode: 'pty',
  allowDangerousMode: false,
  approvalOwnership: 'provider-owned'
};

function expectNativeCliOutputContract(events: unknown[]): void {
  for (const event of events) {
    expect(nativeCliOutputEventSchema.safeParse(event).success).toBe(true);
  }
}

test('Codex adapter launches an interactive CLI rooted at the requested working path', () => {
  const launch = buildNativeCliLaunch(codexAgent, { workingPath: '/tmp/project', launchMode: 'pty' });

  expect(launch.argv).toEqual(['codex', '--cd', '/tmp/project', '--no-alt-screen']);
  expect(launch.cwd).toBe('/tmp/project');
  expect(launch.capabilities).toContain('remote-control');
  expect(launch.capabilities).toContain('session-resume');
  expect(launch.capabilities).toContain('rollout-json-fallback');
  expect(launch.approvalOwnership).toBe('provider-owned');
});

test('native CLI adapters pass managed agent workspace as an additional accessible directory', () => {
  const codex = buildNativeCliLaunch(codexAgent, {
    workingPath: '/tmp/project',
    extraWorkingPaths: ['/tmp/agent-workspace'],
    launchMode: 'pty'
  });
  const claude = buildNativeCliLaunch(claudeAgent, {
    workingPath: '/tmp/project',
    extraWorkingPaths: ['/tmp/agent-workspace'],
    launchMode: 'json-stream'
  });
  const gemini = buildNativeCliLaunch(geminiAgent, {
    workingPath: '/tmp/project',
    extraWorkingPaths: ['/tmp/agent-workspace'],
    launchMode: 'json-stream'
  });
  const qwen = buildNativeCliLaunch(qwenAgent, {
    workingPath: '/tmp/project',
    extraWorkingPaths: ['/tmp/agent-workspace'],
    launchMode: 'json-stream'
  });

  expect(codex.argv).toContain('--add-dir');
  expect(codex.argv).toContain('/tmp/agent-workspace');
  expect(claude.argv).toContain('--add-dir');
  expect(claude.argv).toContain('/tmp/agent-workspace');
  expect(gemini.argv).toContain('--include-directories');
  expect(gemini.argv).toContain('/tmp/agent-workspace');
  expect(qwen.argv).toContain('--include-directories');
  expect(qwen.argv).toContain('/tmp/agent-workspace');
});

test('Codex adapter passes requested model id and reasoning effort to provider launch', () => {
  const pty = buildNativeCliLaunch(codexAgent, {
    workingPath: '/tmp/project',
    launchMode: 'pty',
    modelId: 'gpt-5.5',
    reasoningEffort: 'high'
  });

  expect(pty.argv).toContain('--model');
  expect(pty.argv).toContain('gpt-5.5');
  expect(pty.argv).toContain('-c');
  expect(pty.argv).toContain('model_reasoning_effort="high"');
});

test('managed native CLI launches force provider approvals to be skipped', () => {
  const codex = buildNativeCliLaunch(codexAgent, {
    workingPath: '/tmp/project',
    launchMode: 'app-server',
    skipProviderApprovals: true
  });
  const claude = buildNativeCliLaunch(claudeAgent, {
    workingPath: '/tmp/project',
    launchMode: 'json-stream',
    systemPromptFile: '/tmp/managed-prompt.md',
    skipProviderApprovals: true
  });
  const gemini = buildNativeCliLaunch(geminiAgent, {
    workingPath: '/tmp/project',
    launchMode: 'json-stream',
    skipProviderApprovals: true
  });
  const qwen = buildNativeCliLaunch(qwenAgent, {
    workingPath: '/tmp/project',
    launchMode: 'json-stream',
    skipProviderApprovals: true
  });

  expect(codex.argv.slice(0, 5)).toEqual(['codex', '--ask-for-approval', 'never', 'app-server', '--stdio']);
  expect(claude.argv).toContain('--dangerously-skip-permissions');
  expect(gemini.argv).toContain('--approval-mode=yolo');
  expect(qwen.argv).toContain('--approval-mode=yolo');
});

test('Codex app-server launch accepts managed MCP config overrides', () => {
  const codex = buildNativeCliLaunch(codexAgent, {
    workingPath: '/tmp/project',
    launchMode: 'app-server',
    skipProviderApprovals: true,
    mcpConfigArgs: [
      '-c',
      'mcp_servers.monad.command="/tmp/agent/bin/monad"',
      '-c',
      'mcp_servers.monad.args=["native-agent","mcp-server"]'
    ]
  });

  expect(codex.argv).toEqual([
    'codex',
    '--ask-for-approval',
    'never',
    '-c',
    'mcp_servers.monad.command="/tmp/agent/bin/monad"',
    '-c',
    'mcp_servers.monad.args=["native-agent","mcp-server"]',
    'app-server',
    '--stdio'
  ]);
});

test('Claude adapter passes requested model id and reasoning effort to the provider', () => {
  const launch = buildNativeCliLaunch(claudeAgent, {
    workingPath: '/tmp/project',
    launchMode: 'json-stream',
    modelId: 'claude-opus-4-8',
    reasoningEffort: 'xhigh',
    speed: 'fast'
  });

  expect(launch.argv).toContain('--model');
  expect(launch.argv).toContain('claude-opus-4-8');
  expect(launch.argv).toContain('--effort');
  expect(launch.argv).toContain('xhigh');
  expect(launch.argv).not.toContain('--speed');
});

test('Claude adapter launches ultracode through session settings instead of --effort', () => {
  const launch = buildNativeCliLaunch(claudeAgent, {
    workingPath: '/tmp/project',
    launchMode: 'json-stream',
    reasoningEffort: 'ultracode'
  });

  expect(launch.argv).not.toContain('--effort');
  expect(launch.argv).toContain('--settings');
  expect(launch.argv).toContain('{"ultracode":true}');
});

test('Claude adapter merges ultracode into existing inline session settings', () => {
  const launch = buildNativeCliLaunch(
    { ...claudeAgent, args: ['--settings', '{"verbose":true}'] },
    {
      workingPath: '/tmp/project',
      launchMode: 'json-stream',
      reasoningEffort: 'ultracode'
    }
  );

  expect(launch.argv).toContain('--settings');
  expect(launch.argv).toContain('{"verbose":true,"ultracode":true}');
});

test('native CLI argument support parser extracts flags and enumerated values from help output', () => {
  const support = parseNativeCliArgumentSupport(`
Usage: cli [options]
  --model <model>
  --effort <level> (low, medium, high, xhigh, max)
  --speed <standard, fast>
  --reasoning-effort possible values: light, deep
`);

  expect(support.flags).toEqual(['--model', '--effort', '--speed', '--reasoning-effort']);
  expect(support.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'light', 'deep']);
  expect(support.speeds).toEqual(['standard', 'fast']);
});

test('Codex argument support probe extracts reasoning efforts from model catalog output', () => {
  const support = codexNativeCliAdapter.argumentSupport?.(codexAgent).parse(
    JSON.stringify({
      models: [
        {
          slug: 'gpt-5.5',
          visibility: 'list',
          supported_reasoning_levels: [
            { effort: 'low' },
            { effort: 'medium' },
            { effort: 'high' },
            { effort: 'xhigh' }
          ],
          additional_speed_tiers: ['fast']
        },
        {
          slug: 'gpt-5.4-mini',
          visibility: 'list',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }]
        }
      ]
    }),
    0
  );

  expect(support?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh']);
  expect(support?.speeds).toEqual(['fast']);
  // Per-model efforts are preserved (the union above flattens them).
  expect(support?.reasoningEffortsByModel).toEqual({
    'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
    'gpt-5.4-mini': ['low', 'medium']
  });
});

test('Codex adapter surfaces a reconnect prompt when a thread start/resume fails', () => {
  const handle = {
    launchMode: 'app-server' as const,
    pendingRequests: new Map<string | number, string>([[5, 'threadResume']]),
    appServer: { send() {}, close() {} },
    nextRequestId: () => 6,
    kill() {}
  };
  // An error response to the resume request means the thread is gone (e.g. codex dropped it after a
  // reconnect) → reconnect prompt, not a provider_error that leaves a dead session "running".
  expect(
    codexNativeCliAdapter.parseOutput(
      JSON.stringify({ id: 5, error: { code: 'ThreadNotFound', message: 'thread not found' } }),
      handle
    )
  ).toEqual([{ type: 'connection_required', payload: { code: 'ThreadNotFound', reason: 'thread not found' } }]);
});

test('native CLI adapters expose provider argument support probes', () => {
  expect(buildNativeCliArgumentSupportProbe(codexAgent)?.launch.argv).toEqual([
    'codex',
    'debug',
    'models',
    '--bundled'
  ]);
  expect(buildNativeCliArgumentSupportProbe(claudeAgent)?.launch.argv).toEqual(['claude', '--help']);
  expect(buildNativeCliArgumentSupportProbe(geminiAgent)?.launch.argv).toEqual(['gemini', '--help']);
  expect(buildNativeCliArgumentSupportProbe(qwenAgent)?.launch.argv).toEqual(['qwen', '--help']);
});

test('Codex adapter launches app-server stdio with initialization messages', () => {
  const launch = buildNativeCliLaunch(codexAgent, { workingPath: '/tmp/project', launchMode: 'app-server' });

  expect(launch.argv).toEqual(['codex', 'app-server', '--stdio']);
  expect(launch.cwd).toBe('/tmp/project');
  expect(launch.appServerTransport).toBe('stdio');
  expect('initialMessages' in launch).toBe(false);
});

test('Codex adapter launches app-server over a ws listener when transport is ws', () => {
  const launch = buildNativeCliLaunch(codexAgent, {
    workingPath: '/tmp/project',
    launchMode: 'app-server',
    appServerTransport: 'ws'
  });

  expect(launch.argv).toEqual(['codex', 'app-server', '--listen', 'ws://127.0.0.1:0']);
  expect(launch.appServerTransport).toBe('ws');
});

test('Codex adapter launches app-server over a unix listener at the allocated socket path', () => {
  const launch = buildNativeCliLaunch(codexAgent, {
    workingPath: '/tmp/project',
    launchMode: 'app-server',
    appServerTransport: 'unix',
    appServerSocketPath: '/tmp/monad-appserver/x.sock'
  });

  expect(launch.argv).toEqual(['codex', 'app-server', '--listen', 'unix:///tmp/monad-appserver/x.sock']);
  expect(launch.appServerTransport).toBe('unix');
});

test('Codex adapter requires a socket path for the unix transport', () => {
  expect(() =>
    buildNativeCliLaunch(codexAgent, {
      workingPath: '/tmp/project',
      launchMode: 'app-server',
      appServerTransport: 'unix'
    })
  ).toThrow(/socket path/);
});

test('Codex preset advertises stdio, ws, and unix app-server transports', () => {
  expect(
    codexNativeCliAdapter.detect({ which: () => undefined, exists: () => true }).supportedAppServerTransports
  ).toEqual(['stdio', 'ws', 'unix']);
});

test('native CLI auth launches provider-owned login and status commands', () => {
  expect(buildNativeCliAuthLaunch(codexAgent).argv).toEqual(['codex', 'login']);
  expect(buildNativeCliAuthStatusLaunch(codexAgent).argv).toEqual(['codex', 'login', 'status']);
  expect(buildNativeCliAuthStatusLaunch(codexAgent).env?.CODEX_NON_INTERACTIVE).toBe('1');
  expect(buildNativeCliAuthLaunch(claudeAgent).argv).toEqual(['claude', 'auth', 'login']);
  expect(buildNativeCliAuthStatusLaunch(claudeAgent).argv).toEqual(['claude', 'auth', 'status', '--json']);
  expect(buildNativeCliAuthLaunch(geminiAgent).argv).toEqual(['gemini']);
  expect(buildNativeCliAuthLaunch(geminiAgent).env).toMatchObject({
    NO_BROWSER: 'true',
    TERM: 'xterm-256color'
  });
  expect(buildNativeCliAuthStatusLaunch(geminiAgent).argv).toEqual([
    process.execPath,
    '--eval',
    expect.stringContaining('google_accounts.json')
  ]);
  expect(buildNativeCliAuthStatusLaunch(geminiAgent).env?.NO_BROWSER).toBeUndefined();
  expect(buildNativeCliAuthLaunch(qwenAgent).argv).toEqual(['qwen']);
  expect(buildNativeCliAuthStatusLaunch(qwenAgent).argv).toEqual(['qwen', '--list-sessions']);
  expect(codexNativeCliAdapter.detect({ which: () => undefined, exists: () => true }).capabilities).toEqual({
    auth: 'pty',
    history: 'paged',
    resume: 'structured',
    approval: 'provider-owned'
  });
  expect(claudeCodeNativeCliAdapter.detect({ which: () => undefined, exists: () => true }).capabilities).toEqual({
    auth: 'pty',
    history: 'provider-owned',
    resume: 'pty',
    approval: 'provider-owned'
  });
  expect(geminiNativeCliAdapter.detect({ which: () => undefined, exists: () => true }).capabilities).toEqual({
    auth: 'pty',
    history: 'provider-owned',
    resume: 'pty',
    approval: 'provider-owned'
  });
  expect(qwenNativeCliAdapter.detect({ which: () => undefined, exists: () => true }).capabilities).toEqual({
    auth: 'pty',
    history: 'provider-owned',
    resume: 'pty',
    approval: 'provider-owned'
  });
});

test('native CLI auth status parsers use structured output or documented status exit codes', () => {
  expect(codexNativeCliAdapter.parseAuthStatus(JSON.stringify({ authenticated: true }), 0)).toBe('authenticated');
  expect(codexNativeCliAdapter.parseAuthStatus(JSON.stringify({ authenticated: false }), 0)).toBe('unauthenticated');
  expect(codexNativeCliAdapter.parseAuthStatus('logged in as zeke', 0)).toBe('authenticated');
  expect(codexNativeCliAdapter.parseAuthStatus('not logged in; run codex login', 1)).toBe('unauthenticated');
  expect(claudeCodeNativeCliAdapter.parseAuthStatus(JSON.stringify({ state: 'authenticated' }), 0)).toBe(
    'authenticated'
  );
  expect(claudeCodeNativeCliAdapter.parseAuthStatus('Authenticated', 0)).toBe('authenticated');
  expect(claudeCodeNativeCliAdapter.parseAuthStatus('Please login', 1)).toBe('unauthenticated');
  expect(claudeCodeNativeCliAdapter.parseAuthStatus('unexpected provider error', 2)).toBe('unknown');
  expect(geminiNativeCliAdapter.parseAuthStatus(JSON.stringify({ authenticated: true }), 0)).toBe('authenticated');
  expect(
    geminiNativeCliAdapter.parseAuthStatus(
      'Please set an Auth method in your /Users/zeke/.gemini/settings.json or specify GEMINI_API_KEY',
      0
    )
  ).toBe('unknown');
  expect(geminiNativeCliAdapter.parseAuthStatus('Waiting for authentication...', 0)).toBe('unknown');
  expect(geminiNativeCliAdapter.parseAuthStatus('command completed', 0)).toBe('unknown');
  expect(qwenNativeCliAdapter.parseAuthStatus(JSON.stringify({ authenticated: true }), 0)).toBe('authenticated');
  expect(qwenNativeCliAdapter.parseAuthStatus('Waiting for authentication...', 0)).toBe('unknown');
});

test('Codex adapter initializes app-server sessions through the adapter hook', () => {
  const writes: string[] = [];
  const handle = {
    launchMode: 'app-server' as const,
    appServer: {
      send(input: string) {
        writes.push(input);
      },
      close() {}
    },
    nextRequestId: () => 2,
    kill() {}
  };

  codexNativeCliAdapter.initialize?.(handle, {
    workingPath: '/tmp/project',
    modelId: 'gpt-5.5',
    reasoningEffort: 'high'
  });

  expect(writes).toHaveLength(3);
  expect(writes.every((line) => line.endsWith('\n'))).toBe(true);
  const messages = writes.map(
    (line) => JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> }
  );
  expect(messages[0]?.params?.capabilities).toEqual({ experimentalApi: true, requestAttestation: false });
  expect(messages[2]).toEqual({
    method: 'thread/start',
    id: 2,
    params: { cwd: '/tmp/project', model: 'gpt-5.5', modelReasoningEffort: 'high' }
  });
});

test('Codex adapter resumes app-server sessions through the adapter hook', () => {
  const writes: string[] = [];
  const handle = {
    launchMode: 'app-server' as const,
    appServer: {
      send(input: string) {
        writes.push(input);
      },
      close() {}
    },
    nextRequestId: () => 2,
    kill() {}
  };

  codexNativeCliAdapter.initialize?.(handle, {
    workingPath: '/tmp/project',
    providerSessionRef: 'codex-thread-1'
  });

  expect(writes).toHaveLength(3);
  expect(writes.every((line) => line.endsWith('\n'))).toBe(true);
  const messages = writes.map(
    (line) => JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> }
  );
  expect(messages[0]?.params?.capabilities).toEqual({ experimentalApi: true, requestAttestation: false });
  expect(messages[2]).toEqual({
    method: 'thread/resume',
    id: 2,
    params: {
      threadId: 'codex-thread-1',
      cwd: '/tmp/project',
      excludeTurns: true,
      initialTurnsPage: {
        limit: 20,
        sortDirection: 'desc',
        itemsView: 'summary'
      }
    }
  });
});

test('Codex adapter defers thread/start until the initialize response when a request ledger is present', () => {
  const writes: string[] = [];
  let seq = 0;
  const handle = {
    launchMode: 'app-server' as const,
    appServer: {
      send(input: string) {
        writes.push(input);
      },
      close() {}
    },
    pendingRequests: new Map<string | number, string>(),
    deferredThreadFrame: undefined as string | undefined,
    nextRequestId: () => seq++,
    kill() {}
  };

  codexNativeCliAdapter.initialize?.(handle, { workingPath: '/tmp/project' });
  // Only the handshake goes out up front; thread/start is parked until the server is initialized.
  expect(writes.map((line) => (JSON.parse(line) as { method: string }).method)).toEqual(['initialize', 'initialized']);
  expect(handle.deferredThreadFrame).toBeTruthy();

  // The initialize response (id 0) releases the parked thread/start.
  codexNativeCliAdapter.parseOutput(JSON.stringify({ id: 0, result: { userAgent: 'codex' } }), handle);
  expect(writes.map((line) => (JSON.parse(line) as { method: string }).method)).toEqual([
    'initialize',
    'initialized',
    'thread/start'
  ]);
  expect(handle.deferredThreadFrame).toBeUndefined();
});

test('Codex adapter tracks the in-flight turn and addresses interrupt/steer at it', () => {
  const writes: string[] = [];
  const handle = {
    launchMode: 'app-server' as const,
    providerSessionRef: 'codex-thread-1',
    appServer: {
      send(input: string) {
        writes.push(input);
      },
      close() {}
    },
    currentTurnId: undefined as string | undefined,
    nextRequestId: () => 99,
    kill() {}
  };

  // No turn in flight yet → interrupt/steer are no-ops.
  codexNativeCliAdapter.interrupt?.(handle);
  expect(writes).toHaveLength(0);

  // A turn/started notification opens the turn.
  codexNativeCliAdapter.parseOutput(
    JSON.stringify({
      method: 'turn/started',
      params: { threadId: 'codex-thread-1', turn: { id: 'turn_7', status: 'inProgress', items: [] } }
    }),
    handle
  );
  expect(handle.currentTurnId).toBe('turn_7');

  codexNativeCliAdapter.interrupt?.(handle);
  codexNativeCliAdapter.steer?.(handle, 'also check the tests');
  expect(JSON.parse(writes[0] ?? '')).toEqual({
    method: 'turn/interrupt',
    id: 99,
    params: { threadId: 'codex-thread-1', turnId: 'turn_7' }
  });
  expect(JSON.parse(writes[1] ?? '')).toEqual({
    method: 'turn/steer',
    id: 99,
    params: {
      threadId: 'codex-thread-1',
      expectedTurnId: 'turn_7',
      input: [{ type: 'text', text: 'also check the tests' }]
    }
  });

  // turn/completed closes the turn → interrupt becomes a no-op again.
  codexNativeCliAdapter.parseOutput(
    JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'codex-thread-1', turn: { id: 'turn_7', status: 'completed', items: [] } }
    }),
    handle
  );
  expect(handle.currentTurnId).toBeUndefined();
  writes.length = 0;
  codexNativeCliAdapter.interrupt?.(handle);
  expect(writes).toHaveLength(0);
});

test('Codex adapter triages turn error notifications by codex error code', () => {
  expect(
    codexNativeCliAdapter.parseOutput(
      JSON.stringify({
        method: 'error',
        params: {
          threadId: 't',
          turnId: 'u',
          willRetry: false,
          error: { message: 'quota', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null }
        }
      })
    )
  ).toEqual([{ type: 'provider_error', payload: { code: 'usageLimitExceeded', message: 'quota' } }]);

  expect(
    codexNativeCliAdapter.parseOutput(
      JSON.stringify({
        method: 'error',
        params: {
          willRetry: false,
          error: { message: 'expired', codexErrorInfo: 'unauthorized', additionalDetails: null }
        }
      })
    )
  ).toEqual([{ type: 'connection_required', payload: { code: 'unauthorized', reason: 'expired' } }]);

  expect(
    codexNativeCliAdapter.parseOutput(
      JSON.stringify({
        method: 'error',
        params: {
          willRetry: false,
          error: {
            message: 'boom',
            codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } },
            additionalDetails: null
          }
        }
      })
    )
  ).toEqual([{ type: 'provider_error', payload: { code: 'httpConnectionFailed', message: 'boom' } }]);

  // codex will retry transient failures itself → suppressed (no event).
  expect(
    codexNativeCliAdapter.parseOutput(
      JSON.stringify({
        method: 'error',
        params: {
          willRetry: true,
          error: {
            message: 'blip',
            codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
            additionalDetails: null
          }
        }
      })
    )
  ).toEqual([]);
});

test('Codex adapter auto-compacts and re-runs the turn on context overflow', () => {
  const writes: string[] = [];
  let seq = 10;
  const handle = {
    launchMode: 'app-server' as const,
    providerSessionRef: 'codex-thread-1',
    appServer: {
      send(input: string) {
        writes.push(input);
      },
      close() {}
    },
    pendingRequests: new Map<string | number, string>(),
    lastTurnInput: undefined as string | undefined,
    turnRecoveries: undefined as number | undefined,
    nextRequestId: () => seq++,
    kill() {}
  };

  codexNativeCliAdapter.sendInput(handle, 'summarize the repo');
  writes.length = 0;

  const overflow = JSON.stringify({
    method: 'error',
    params: {
      threadId: 'codex-thread-1',
      turnId: 'u1',
      willRetry: false,
      error: { message: 'too long', codexErrorInfo: 'contextWindowExceeded', additionalDetails: null }
    }
  });

  // First overflow → silently compact + re-run (no surfaced error).
  expect(codexNativeCliAdapter.parseOutput(overflow, handle)).toEqual([]);
  expect(writes.map((w) => (JSON.parse(w) as { method: string }).method)).toEqual([
    'thread/compact/start',
    'turn/start'
  ]);
  expect((JSON.parse(writes[1] ?? '') as { params: { input: unknown } }).params.input).toEqual([
    { type: 'text', text: 'summarize the repo' }
  ]);
  expect(handle.turnRecoveries).toBe(1);

  // Second overflow in the same turn → recovery budget spent, surface the error.
  writes.length = 0;
  expect(codexNativeCliAdapter.parseOutput(overflow, handle)).toEqual([
    { type: 'provider_error', payload: { code: 'contextWindowExceeded', message: 'too long' } }
  ]);
  expect(writes).toHaveLength(0);
});

test('Codex adapter rejects dangerous bypass args unless enabled in config', () => {
  expect(() =>
    buildNativeCliLaunch(
      { ...codexAgent, args: ['--dangerously-bypass-approvals-and-sandbox'] },
      { workingPath: '/tmp/project', launchMode: 'pty' }
    )
  ).toThrow(/dangerous/i);
});

test('Codex adapter allows dangerous bypass args only when explicitly enabled', () => {
  const launch = buildNativeCliLaunch(
    { ...codexAgent, args: ['--dangerously-bypass-approvals-and-sandbox'], allowDangerousMode: true },
    { workingPath: '/tmp/project', launchMode: 'pty' }
  );

  expect(launch.argv).toContain('--dangerously-bypass-approvals-and-sandbox');
});

test('native CLI launch rejects shell command strings in command fields', () => {
  expect(() =>
    buildNativeCliLaunch({ ...codexAgent, command: 'codex --cd /tmp/project' }, { workingPath: '/tmp/project' })
  ).toThrow(/command/i);
});

test('Claude Code adapter launches in the requested cwd and advertises stream-json capability', () => {
  const launch = buildNativeCliLaunch(claudeAgent, { workingPath: '/tmp/project', launchMode: 'pty' });

  expect(launch.argv).toEqual(['claude']);
  expect(launch.cwd).toBe('/tmp/project');
  expect(launch.capabilities).toContain('json-stream');
  expect(launch.capabilities).toContain('structured-output');
  expect(launch.capabilities).toContain('session-resume');
  expect(launch.approvalOwnership).toBe('provider-owned');
});

test('Claude Code adapter passes requested model id and reasoning effort to provider launch', () => {
  const launch = buildNativeCliLaunch(claudeAgent, {
    workingPath: '/tmp/project',
    launchMode: 'pty',
    modelId: 'sonnet',
    reasoningEffort: 'max'
  });

  expect(launch.argv).toEqual(['claude', '--model', 'sonnet', '--effort', 'max']);
});

test('Claude Code adapter launches structured stream-json mode with print protocol flags', () => {
  const launch = buildNativeCliLaunch(claudeAgent, { workingPath: '/tmp/project', launchMode: 'json-stream' });

  expect(launch.argv).toEqual([
    'claude',
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose'
  ]);
  expect(launch.cwd).toBe('/tmp/project');
  expect(launch.launchMode).toBe('json-stream');
});

test('Claude Code managed project launches allow Monad bridge commands', () => {
  const launch = buildNativeCliLaunch(claudeAgent, {
    workingPath: '/tmp/project',
    launchMode: 'json-stream',
    systemPromptFile: '/tmp/project/managed-prompt.md'
  });

  expect(launch.argv).toContain('--append-system-prompt-file');
  expect(launch.argv).toContain('/tmp/project/managed-prompt.md');
  expect(launch.argv).toContain('--allowedTools');
  expect(launch.argv).toContain('Bash(monad project *)');
  expect(launch.argv).toContain('Bash(monad agent *)');
  expect(launch.argv).toContain('Bash(monad runtime info)');
});

test('Claude Code adapter resumes with the provider session ref in PTY and stream-json modes', () => {
  const pty = buildNativeCliLaunch(claudeAgent, {
    workingPath: '/tmp/project',
    launchMode: 'pty',
    providerSessionRef: 'claude-session-1'
  });
  const stream = buildNativeCliLaunch(claudeAgent, {
    workingPath: '/tmp/project',
    launchMode: 'json-stream',
    providerSessionRef: 'claude-session-1'
  });

  expect(pty.argv).toEqual(['claude', '--resume', 'claude-session-1']);
  expect(stream.argv).toContain('--resume');
  expect(stream.argv).toContain('claude-session-1');
});

test('Gemini adapter launches in the requested cwd and advertises stream-json capability', () => {
  const launch = buildNativeCliLaunch(geminiAgent, { workingPath: '/tmp/project', launchMode: 'pty' });

  expect(launch.argv).toEqual(['gemini']);
  expect(launch.cwd).toBe('/tmp/project');
  expect(launch.capabilities).toContain('json-stream');
  expect(launch.capabilities).toContain('structured-output');
  expect(launch.capabilities).toContain('session-resume');
  expect(launch.approvalOwnership).toBe('provider-owned');
});

test('Gemini adapter launches structured stream-json mode with official output-format flag', () => {
  const launch = buildNativeCliLaunch(geminiAgent, { workingPath: '/tmp/project', launchMode: 'json-stream' });

  expect(launch.argv).toEqual(['gemini', '-p', '', '--output-format', 'stream-json']);
  expect(launch.cwd).toBe('/tmp/project');
  expect(launch.launchMode).toBe('json-stream');
});

test('Gemini adapter resumes with the provider session ref in PTY and stream-json modes', () => {
  const pty = buildNativeCliLaunch(geminiAgent, {
    workingPath: '/tmp/project',
    launchMode: 'pty',
    providerSessionRef: 'gemini-session-1'
  });
  const stream = buildNativeCliLaunch(geminiAgent, {
    workingPath: '/tmp/project',
    launchMode: 'json-stream',
    providerSessionRef: 'gemini-session-1'
  });

  expect(pty.argv).toEqual(['gemini', '--resume', 'gemini-session-1']);
  expect(stream.argv).toContain('--resume');
  expect(stream.argv).toContain('gemini-session-1');
});

test('Qwen adapter launches in the requested cwd and advertises stream-json capability', () => {
  const launch = buildNativeCliLaunch(qwenAgent, { workingPath: '/tmp/project', launchMode: 'pty' });

  expect(launch.argv).toEqual(['qwen']);
  expect(launch.cwd).toBe('/tmp/project');
  expect(launch.capabilities).toContain('json-stream');
  expect(launch.capabilities).toContain('structured-output');
  expect(launch.capabilities).toContain('session-resume');
  expect(launch.approvalOwnership).toBe('provider-owned');
});

test('Qwen adapter launches the SDK bidirectional stream-json session (input + output)', () => {
  const launch = buildNativeCliLaunch(qwenAgent, { workingPath: '/tmp/project', launchMode: 'json-stream' });

  expect(launch.argv).toEqual(['qwen', '--input-format', 'stream-json', '--output-format', 'stream-json']);
  expect(launch.cwd).toBe('/tmp/project');
  expect(launch.launchMode).toBe('json-stream');
  expect(launch.capabilities).toContain('approval-resolution');
});

test('Qwen adapter resumes with the provider session ref in PTY and stream-json modes', () => {
  const pty = buildNativeCliLaunch(qwenAgent, {
    workingPath: '/tmp/project',
    launchMode: 'pty',
    providerSessionRef: 'qwen-session-1'
  });
  const stream = buildNativeCliLaunch(qwenAgent, {
    workingPath: '/tmp/project',
    launchMode: 'json-stream',
    providerSessionRef: 'qwen-session-1'
  });

  expect(pty.argv).toEqual(['qwen', '--resume', 'qwen-session-1']);
  expect(stream.argv).toContain('--resume');
  expect(stream.argv).toContain('qwen-session-1');
});

test('Gemini adapter keeps yolo approval mode behind dangerous mode opt-in', () => {
  expect(() =>
    buildNativeCliLaunch({ ...geminiAgent, args: ['--approval-mode=yolo'] }, { workingPath: '/tmp/project' })
  ).toThrow(/dangerous/i);
  expect(() =>
    buildNativeCliLaunch({ ...geminiAgent, args: ['--approval-mode', 'yolo'] }, { workingPath: '/tmp/project' })
  ).toThrow(/dangerous/i);
  expect(() => buildNativeCliLaunch({ ...geminiAgent, args: ['--yolo'] }, { workingPath: '/tmp/project' })).toThrow(
    /dangerous/i
  );

  expect(
    buildNativeCliLaunch(
      { ...geminiAgent, args: ['--approval-mode=yolo'], allowDangerousMode: true },
      { workingPath: '/tmp/project' }
    ).argv
  ).toContain('--approval-mode=yolo');
});

test('native CLI presets detect Codex, Claude Code, Gemini, and Qwen as direct client commands', () => {
  const presets = listNativeCliAgentPresets({ which: (name) => `/bin/${name}`, exists: () => false });

  expect(presets.map((preset) => preset.id).sort()).toEqual([
    'claude-code',
    'codex',
    'gemini',
    'hermes',
    'openclaw',
    'qwen'
  ]);
  expect(presets.find((preset) => preset.id === 'codex')?.command).toBe('codex');
  expect(presets.find((preset) => preset.id === 'codex')?.productIcon).toBe('codex');
  expect(presets.find((preset) => preset.id === 'claude-code')?.command).toBe('claude');
  expect(presets.find((preset) => preset.id === 'claude-code')?.productIcon).toBe('claude-code');
  expect(presets.find((preset) => preset.id === 'gemini')?.command).toBe('gemini');
  expect(presets.find((preset) => preset.id === 'gemini')?.productIcon).toBe('gemini');
  expect(presets.find((preset) => preset.id === 'qwen')?.productIcon).toBe('qwen');
  expect(presets.find((preset) => preset.id === 'qwen')?.command).toBe('qwen');
  expect(presets.find((preset) => preset.id === 'codex')?.installUrl).toBe('https://developers.openai.com/codex/cli');
  expect(presets.find((preset) => preset.id === 'claude-code')?.installUrl).toBe(
    'https://docs.anthropic.com/en/docs/claude-code/setup'
  );
  expect(presets.find((preset) => preset.id === 'gemini')?.installUrl).toBe(
    'https://github.com/google-gemini/gemini-cli'
  );
  expect(presets.find((preset) => preset.id === 'qwen')?.installUrl).toBe(
    'https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/'
  );
  expect(presets.find((preset) => preset.id === 'codex')?.modelOptions).toEqual([
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex',
    'gpt-5.2'
  ]);
  expect(presets.find((preset) => preset.id === 'claude-code')?.modelOptions).toEqual([
    'fable',
    'opus',
    'sonnet',
    'haiku'
  ]);
  expect(presets.find((preset) => preset.id === 'gemini')?.modelOptions).toEqual([
    'gemini-2.5-pro',
    'gemini-2.5-flash'
  ]);
  expect(presets.find((preset) => preset.id === 'qwen')?.modelOptions).toEqual([
    'qwen3-coder-plus',
    'qwen3-coder-flash'
  ]);
});

test('native CLI adapters expose supported model options with agent override', () => {
  expect(codexNativeCliAdapter.listSupportedModels()).toEqual([
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex',
    'gpt-5.2'
  ]);
  expect(claudeCodeNativeCliAdapter.listSupportedModels()).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  expect(geminiNativeCliAdapter.listSupportedModels()).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);
  expect(qwenNativeCliAdapter.listSupportedModels()).toEqual(['qwen3-coder-plus', 'qwen3-coder-flash']);
  expect(codexNativeCliAdapter.listSupportedModels({ ...codexAgent, modelOptions: ['custom-codex'] })).toEqual([
    'custom-codex'
  ]);
});

test('native CLI model option probes parse command output', () => {
  expect(
    codexNativeCliAdapter.modelOptions?.(codexAgent).parse(
      JSON.stringify({
        models: [
          { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
          { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide' },
          { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list' }
        ]
      }),
      0
    )
  ).toEqual(['gpt-5.5', 'gpt-5.4-mini']);
  expect(codexNativeCliAdapter.modelOptions?.(codexAgent).parse('optional config example: o3', 0)).toEqual([]);
  expect(claudeCodeNativeCliAdapter.modelOptions).toBeUndefined();
  expect(geminiNativeCliAdapter.modelOptions).toBeUndefined();
  expect(qwenNativeCliAdapter.modelOptions).toBeUndefined();
});

test('native CLI model options prefer command probe output before adapter fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'monad-native-cli-model-options-'));
  const command = join(dir, process.platform === 'win32' ? 'fake-codex.cmd' : 'fake-codex');
  const catalog = JSON.stringify({
    models: [
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
      { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list' }
    ]
  });
  writeFileSync(
    command,
    process.platform === 'win32'
      ? `@echo off\r\necho ${catalog}\r\n`
      : `#!/usr/bin/env sh\nprintf '%s\\n' '${catalog}'\n`
  );
  chmodSync(command, 0o755);

  expect(
    listNativeCliAgentModelOptions(
      { ...codexAgent, command: 'fake-codex' },
      { which: (name) => (name === 'fake-codex' ? command : undefined), exists: () => false }
    )
  ).toEqual(['gpt-5.5', 'gpt-5.4-mini']);
});

test('Codex model options ignore single o-series help examples and use adapter fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'monad-native-cli-codex-help-'));
  const command = join(dir, process.platform === 'win32' ? 'fake-codex.cmd' : 'fake-codex');
  writeFileSync(
    command,
    process.platform === 'win32'
      ? '@echo off\r\necho Optional config example: o3\r\n'
      : '#!/usr/bin/env sh\necho "Optional config example: o3"\n'
  );
  chmodSync(command, 0o755);

  expect(
    listNativeCliAgentModelOptions(
      { ...codexAgent, command: 'fake-codex' },
      { which: (name) => (name === 'fake-codex' ? command : undefined), exists: () => false }
    )
  ).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2']);
});

test('PTY input normalizes final newline to terminal Enter', () => {
  expect(normalizePtyInput('hi\n')).toBe('hi\r');
  expect(normalizePtyInput('first\nsecond\n')).toBe('first\nsecond\r');
  expect(normalizePtyInput('hi')).toBe('hi');
});

test('native CLI launch resolves provider commands before spawn', () => {
  const codexLaunch = resolveNativeCliLaunchCommand(
    codexNativeCliAdapter,
    buildNativeCliLaunch(codexAgent, { workingPath: '/tmp/project', launchMode: 'pty' }),
    { which: () => undefined, exists: (path) => path === '/Applications/Codex.app/Contents/Resources/codex' }
  );
  const claudeLaunch = resolveNativeCliLaunchCommand(
    claudeCodeNativeCliAdapter,
    buildNativeCliLaunch(claudeAgent, { workingPath: '/tmp/project', launchMode: 'pty' }),
    { which: (name) => (name === 'claude' ? '/Users/zeke/.local/bin/claude' : undefined), exists: () => false }
  );
  const geminiLaunch = resolveNativeCliLaunchCommand(
    geminiNativeCliAdapter,
    buildNativeCliLaunch(geminiAgent, { workingPath: '/tmp/project', launchMode: 'pty' }),
    { which: (name) => (name === 'gemini' ? '/Users/zeke/.bun/bin/gemini' : undefined), exists: () => false }
  );
  const qwenLaunch = resolveNativeCliLaunchCommand(
    qwenNativeCliAdapter,
    buildNativeCliLaunch(qwenAgent, { workingPath: '/tmp/project', launchMode: 'pty' }),
    { which: (name) => (name === 'qwen' ? '/Users/zeke/.bun/bin/qwen' : undefined), exists: () => false }
  );

  expect(codexLaunch.argv[0]).toBe('/Applications/Codex.app/Contents/Resources/codex');
  expect(claudeLaunch.argv[0]).toBe('/Users/zeke/.local/bin/claude');
  expect(geminiLaunch.argv[0]).toBe('/Users/zeke/.bun/bin/gemini');
  expect(qwenLaunch.argv[0]).toBe('/Users/zeke/.bun/bin/qwen');
});

test('native CLI launch fails before spawn when provider command cannot be resolved', () => {
  expect(() =>
    resolveNativeCliLaunchCommand(
      codexNativeCliAdapter,
      buildNativeCliLaunch(codexAgent, { workingPath: '/tmp/project', launchMode: 'pty' }),
      { which: () => undefined, exists: () => false }
    )
  ).toThrow(/Executable not found/);
});

test('Codex adapter parses app-server raw response item notifications into structured events', () => {
  const chunk = [
    JSON.stringify({
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_456',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '我会先读取本机 session 结构。' }]
        }
      }
    }),
    JSON.stringify({
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_456',
        item: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call_waNNU2Hk4KxwzqflFGFm5E2k',
          arguments: JSON.stringify({
            cmd: "which codex && codex --help | sed -n '1,180p'",
            workdir: '/Users/zeke/Documents/Codex/2026-06-28/w'
          })
        }
      }
    }),
    JSON.stringify({
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_456',
        item: {
          type: 'function_call_output',
          call_id: 'call_waNNU2Hk4KxwzqflFGFm5E2k',
          output: '/opt/homebrew/bin/codex\\nCodex CLI\\n'
        }
      }
    }),
    JSON.stringify({
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_456',
        item: {
          type: 'web_search_call',
          id: 'ws_1',
          status: 'completed'
        }
      }
    })
  ].join('\n');

  const events = codexNativeCliAdapter.parseOutput(chunk);
  expectNativeCliOutputContract(events);
  expect(events).toEqual([
    { type: 'agent_message', payload: { text: '我会先读取本机 session 结构。' } },
    {
      type: 'tool_call',
      payload: {
        callId: 'call_waNNU2Hk4KxwzqflFGFm5E2k',
        tool: 'exec_command',
        input: {
          cmd: "which codex && codex --help | sed -n '1,180p'",
          workdir: '/Users/zeke/Documents/Codex/2026-06-28/w'
        }
      }
    },
    {
      type: 'tool_result',
      payload: {
        callId: 'call_waNNU2Hk4KxwzqflFGFm5E2k',
        output: '/opt/homebrew/bin/codex\\nCodex CLI\\n'
      }
    },
    {
      type: 'web_search_result',
      payload: {
        callId: 'ws_1',
        status: 'completed'
      }
    }
  ]);
});

test('native CLI adapters ignore malformed and unknown provider output outside the Monad contract', () => {
  expect(codexNativeCliAdapter.parseOutput('not-json\n{"method":"unknown/event","params":{"x":1}}\n')).toEqual([]);
  const invalidApproval = codexNativeCliAdapter.parseOutput(
    JSON.stringify({
      method: 'item/commandExecution/requestApproval',
      params: { command: 'echo missing request id' }
    })
  );
  expect(invalidApproval.every((event) => nativeCliOutputEventSchema.safeParse(event).success)).toBe(false);
  expect(claudeCodeNativeCliAdapter.parseOutput('not-json\n{"type":"unknown","session_id":"s"}\n')).toEqual([]);
  expect(geminiNativeCliAdapter.parseOutput('not-json\n{"type":"unknown","session_id":"s"}\n')).toEqual([]);
  expect(qwenNativeCliAdapter.parseOutput('not-json\n{"type":"unknown","session_id":"s"}\n')).toEqual([]);
});

test('Codex app-server turn completion extracts the final agent message from turn items', () => {
  const events = codexNativeCliAdapter.parseOutput(
    JSON.stringify({
      method: 'turn/completed',
      params: {
        threadId: 'thr_123',
        turn: {
          id: 'turn_456',
          status: 'completed',
          items: [
            { type: 'reasoning', id: 'r1', summary: 'thinking' },
            { type: 'agentMessage', id: 'm1', text: 'No action needed.' }
          ]
        }
      }
    })
  );

  expectNativeCliOutputContract(events);
  expect(events).toEqual([{ type: 'agent_message', payload: { text: 'No action needed.', final: true } }]);
});

test('Codex app-server turn completion with no message is still a final turn-boundary event', () => {
  const events = codexNativeCliAdapter.parseOutput(
    JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'thr_123', turn: { id: 't', status: 'completed', items: [] } }
    })
  );
  expect(events).toEqual([{ type: 'agent_message', payload: { final: true } }]);
});

test('Codex adapter auto-declines an unhandled server-initiated request so the turn cannot hang', () => {
  const writes: string[] = [];
  const handle = {
    launchMode: 'app-server' as const,
    appServer: {
      send(input: string) {
        writes.push(input);
      },
      close() {}
    },
    pendingRequests: new Map<string | number, string>(),
    nextRequestId: () => 1,
    kill() {}
  };

  const events = codexNativeCliAdapter.parseOutput(
    JSON.stringify({ method: 'tool/requestUserInput', id: 42, params: { questions: [] } }),
    handle
  );

  expect(events).toEqual([]);
  expect(JSON.parse(writes[0] ?? '')).toEqual({
    id: 42,
    error: { code: -32601, message: 'Unsupported method: tool/requestUserInput' }
  });
});

test('Codex adapter ignores an unhandled server notification (no id) without replying', () => {
  const writes: string[] = [];
  const handle = {
    launchMode: 'app-server' as const,
    appServer: {
      send(input: string) {
        writes.push(input);
      },
      close() {}
    },
    pendingRequests: new Map<string | number, string>(),
    nextRequestId: () => 1,
    kill() {}
  };
  const events = codexNativeCliAdapter.parseOutput(
    JSON.stringify({ method: 'fuzzyFileSearch/sessionUpdated', params: {} }),
    handle
  );
  expect(events).toEqual([]);
  expect(writes).toHaveLength(0);
});

test('Codex adapter dispatches app-server responses by request id, not result shape', () => {
  const handle = {
    launchMode: 'app-server' as const,
    appServer: { send() {}, close() {} },
    pendingRequests: new Map<string | number, string>([
      [3, 'thread'],
      [4, 'historyPage']
    ]),
    nextRequestId: () => 5,
    kill() {}
  };

  // A thread response whose result also happens to carry a `data` array must still resolve as a
  // session ref because id 3 was recorded as a `thread` request.
  const threadEvents = codexNativeCliAdapter.parseOutput(
    JSON.stringify({
      id: 3,
      result: { thread: { id: 'codex-thread-9' }, data: [], nextCursor: null, backwardsCursor: null }
    }),
    handle
  );
  expect(threadEvents).toEqual([
    { type: 'session_ref', payload: { providerSessionRef: 'codex-thread-9', responseId: 3 } }
  ]);

  const historyEvents = codexNativeCliAdapter.parseOutput(
    JSON.stringify({ id: 4, result: { data: [{ id: 'turn-1', items: [] }], nextCursor: 'n1', backwardsCursor: null } }),
    handle
  );
  expect(historyEvents).toEqual([
    {
      type: 'history_page',
      payload: { responseId: 4, items: [{ id: 'turn-1', items: [] }], nextCursor: 'n1', backwardsCursor: null }
    }
  ]);
});

// Fixtures use the real gemini-cli `--output-format stream-json` schema (verified against
// gemini-cli v0.49.0's StreamJsonFormatter): `content` on message, `tool_name`/`tool_id`/
// `parameters` on tool_use, `tool_id`/`status`/`output` on tool_result, and a `result` event that
// carries stats — not text. The assistant reply is reconstructed from the streamed `message`
// deltas and flushed as the turn-final `agent_message`.
test('Gemini adapter translates stream-json events into the Monad native CLI contract', () => {
  const chunk = [
    JSON.stringify({ type: 'init', session_id: 'gemini-session-1', model: 'gemini-2.5-pro' }),
    JSON.stringify({ type: 'message', role: 'user', content: 'inspect the project' }),
    JSON.stringify({ type: 'message', role: 'assistant', content: 'I will inspect the project.', delta: true }),
    JSON.stringify({ type: 'tool_use', tool_name: 'read_file', tool_id: 'tool-1', parameters: { path: 'README.md' } }),
    JSON.stringify({ type: 'tool_result', tool_id: 'tool-1', status: 'success', output: 'README contents' }),
    JSON.stringify({ type: 'result', status: 'success', stats: { total_tokens: 42 } })
  ].join('\n');

  const events = geminiNativeCliAdapter.parseOutput(chunk);
  expectNativeCliOutputContract(events);
  expect(events).toEqual([
    { type: 'session_ref', payload: { providerSessionRef: 'gemini-session-1', model: 'gemini-2.5-pro' } },
    { type: 'agent_message', payload: { text: 'I will inspect the project.' } },
    { type: 'tool_call', payload: { callId: 'tool-1', tool: 'read_file', input: { path: 'README.md' } } },
    { type: 'tool_result', payload: { callId: 'tool-1', output: 'README contents' } },
    { type: 'agent_message', payload: { text: 'I will inspect the project.', final: true } }
  ]);
});

test('Gemini adapter surfaces error results and drops non-fatal warnings', () => {
  const warned = geminiNativeCliAdapter.parseOutput(
    [
      JSON.stringify({ type: 'error', severity: 'warning', message: 'Loop detected, stopping execution' }),
      JSON.stringify({ type: 'result', status: 'success', stats: {} })
    ].join('\n')
  );
  // A `warning` is already visible in the raw output card, so it is not escalated; the successful
  // result with no accumulated text is a bare final marker.
  expect(warned).toEqual([{ type: 'agent_message', payload: { final: true } }]);

  const failed = geminiNativeCliAdapter.parseOutput(
    JSON.stringify({
      type: 'result',
      status: 'error',
      error: { type: 'INVALID_STREAM', message: 'Model returned an empty response' }
    })
  );
  expectNativeCliOutputContract(failed);
  expect(failed).toEqual([
    { type: 'provider_error', payload: { message: 'Model returned an empty response', code: 'INVALID_STREAM' } }
  ]);
});

// Qwen Code diverged from gemini-cli's flat stream-json: `--output-format stream-json` emits the
// Claude-Code-compatible `SDKMessage` protocol (system/assistant/user/result with Anthropic content
// blocks), verified against the official `@qwen-code/sdk` `types/protocol.ts` and the qwen-code
// headless docs — not the `{type:'message', tool_name, ...}` shape the `gemini` adapter parses.
test('Qwen adapter translates SDK stream-json messages into the Monad native CLI contract', () => {
  const chunk = [
    JSON.stringify({
      type: 'system',
      subtype: 'session_start',
      session_id: 'qwen-session-1',
      model: 'qwen3-coder',
      cwd: '/tmp/project'
    }),
    JSON.stringify({
      type: 'assistant',
      session_id: 'qwen-session-1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect the project.' },
          { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } }
        ]
      }
    }),
    JSON.stringify({
      type: 'user',
      session_id: 'qwen-session-1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'README contents' }] }
    }),
    JSON.stringify({ type: 'result', subtype: 'success', session_id: 'qwen-session-1', result: 'Inspection complete.' })
  ].join('\n');

  const events = qwenNativeCliAdapter.parseOutput(chunk);
  expectNativeCliOutputContract(events);
  expect(events).toEqual([
    {
      type: 'session_ref',
      payload: { providerSessionRef: 'qwen-session-1', model: 'qwen3-coder', cwd: '/tmp/project' }
    },
    { type: 'agent_message', payload: { text: 'I will inspect the project.' } },
    { type: 'tool_call', payload: { callId: 'tool-1', tool: 'read_file', input: { path: 'README.md' } } },
    { type: 'tool_result', payload: { callId: 'tool-1', output: 'README contents' } },
    { type: 'agent_message', payload: { text: 'Inspection complete.', final: true } }
  ]);
});

test('Qwen adapter surfaces error results as provider errors', () => {
  const events = qwenNativeCliAdapter.parseOutput(
    JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      session_id: 'qwen-session-1',
      is_error: true,
      error: { type: 'INVALID_STREAM', message: 'Model returned an empty response' }
    })
  );
  expectNativeCliOutputContract(events);
  expect(events).toEqual([
    { type: 'provider_error', payload: { message: 'Model returned an empty response', code: 'INVALID_STREAM' } }
  ]);
});

test('Qwen adapter surfaces can_use_tool control requests and resolves them over the control plane', () => {
  const writes: string[] = [];
  const handle = {
    launchMode: 'json-stream' as const,
    providerSessionRef: 'qwen-session-1',
    stdin: {
      write(input: string) {
        writes.push(input);
      }
    },
    nextRequestId: () => 1,
    kill() {}
  };

  const events = qwenNativeCliAdapter.parseOutput(
    JSON.stringify({
      type: 'control_request',
      request_id: 'req-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'run_shell_command',
        tool_use_id: 'call-1',
        input: { command: 'ls' },
        permission_suggestions: null,
        blocked_path: null
      }
    }),
    handle
  );
  expectNativeCliOutputContract(events);
  expect(events).toEqual([
    {
      type: 'approval_requested',
      payload: {
        requestId: 'req-1',
        kind: 'can_use_tool',
        tool: 'run_shell_command',
        callId: 'call-1',
        input: { command: 'ls' },
        permissionSuggestions: null,
        blockedPath: null
      }
    }
  ]);
  expect(writes).toHaveLength(0);

  qwenNativeCliAdapter.resolveApproval(handle, {
    requestId: 'req-1',
    allow: true,
    request: { input: { command: 'ls' } }
  });
  expect(JSON.parse(writes[0] ?? '')).toEqual({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'req-1',
      response: { behavior: 'allow', updatedInput: { command: 'ls' } }
    }
  });
});

test('Qwen adapter auto-declines unsupported control requests so the turn cannot hang', () => {
  const writes: string[] = [];
  const handle = {
    launchMode: 'json-stream' as const,
    stdin: {
      write(input: string) {
        writes.push(input);
      }
    },
    nextRequestId: () => 1,
    kill() {}
  };

  const events = qwenNativeCliAdapter.parseOutput(
    JSON.stringify({
      type: 'control_request',
      request_id: 'req-2',
      request: { subtype: 'mcp_message', server_name: 'x', message: { method: 'y' } }
    }),
    handle
  );
  expect(events).toEqual([]);
  expect(JSON.parse(writes[0] ?? '')).toEqual({
    type: 'control_response',
    response: { subtype: 'error', request_id: 'req-2', error: 'Unsupported control request: mcp_message' }
  });
});

test('Qwen adapter initializes and frames turns through the SDK stream-json bridge', () => {
  const writes: string[] = [];
  const handle = {
    launchMode: 'json-stream' as const,
    providerSessionRef: 'qwen-session-1',
    stdin: {
      write(input: string) {
        writes.push(input);
      }
    },
    nextRequestId: () => 5,
    kill() {}
  };

  qwenNativeCliAdapter.initialize?.(handle, { workingPath: '/tmp/project' });
  qwenNativeCliAdapter.sendInput(handle, 'summarize');

  expect(writes).toHaveLength(2);
  expect(writes.every((line) => line.endsWith('\n'))).toBe(true);
  expect(JSON.parse(writes[0] ?? '')).toEqual({
    type: 'control_request',
    request_id: 'init-5',
    request: { subtype: 'initialize', hooks: null }
  });
  expect(JSON.parse(writes[1] ?? '')).toEqual({
    type: 'user',
    session_id: 'qwen-session-1',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: 'summarize' }] }
  });
});

test('Gemini adapter does not infer semantics from PTY prompt text', () => {
  const chunk = [
    '\u001b[1mDo you trust the files in this folder?\u001b[22m',
    '● 1. Trust folder (monad)',
    "  3. Don't trust",
    'Do you want to connect VS Code to Gemini CLI?',
    '● 1. Yes',
    '  2. No (esc)',
    'Waiting for authentication... (Press Esc or Ctrl+C to cancel)'
  ].join('\n');

  const events = geminiNativeCliAdapter.parseOutput(chunk);
  expectNativeCliOutputContract(events);
  expect(events).toEqual([]);
});

test('Gemini adapter leaves PTY prompt resolution to the raw terminal input bridge', () => {
  const writes: string[] = [];
  const handle = {
    launchMode: 'pty' as const,
    terminal: {
      write(input: string) {
        writes.push(input);
      },
      resize() {},
      close() {}
    },
    kill() {}
  };

  geminiNativeCliAdapter.resolveApproval(handle, {
    requestId: 'gemini:folder-trust',
    allow: true,
    request: { kind: 'folder_trust' }
  });

  expect(writes).toEqual([]);
});

test('Codex adapter parses app-server thread start response into a provider session ref', () => {
  const chunk = JSON.stringify({
    id: 1,
    result: {
      thread: {
        id: 'codex-thread-1'
      }
    }
  });

  const events = codexNativeCliAdapter.parseOutput(chunk);
  expectNativeCliOutputContract(events);
  expect(events).toEqual([
    {
      type: 'session_ref',
      payload: {
        providerSessionRef: 'codex-thread-1',
        responseId: 1
      }
    }
  ]);
});

test('Codex adapter parses app-server JSON-RPC errors as provider errors', () => {
  const events = codexNativeCliAdapter.parseOutput(
    JSON.stringify({ id: 1, error: { code: -32000, message: 'resume missing' } })
  );

  expectNativeCliOutputContract(events);
  expect(events).toEqual([
    {
      type: 'provider_error',
      payload: {
        responseId: 1,
        code: -32000,
        message: 'resume missing'
      }
    }
  ]);
});

test('Codex adapter routes Unauthorized app-server errors to a reconnect prompt', () => {
  const events = codexNativeCliAdapter.parseOutput(
    JSON.stringify({
      id: 2,
      error: { code: 'Unauthorized', message: 'Your session has expired', codexErrorInfo: 'Unauthorized' }
    })
  );
  expectNativeCliOutputContract(events);
  expect(events).toEqual([
    {
      type: 'connection_required',
      payload: { code: 'Unauthorized', reason: 'Your session has expired' }
    }
  ]);
});

test('Codex adapter keeps non-auth app-server errors as provider errors', () => {
  const events = codexNativeCliAdapter.parseOutput(
    JSON.stringify({ id: 3, error: { code: -32000, message: 'resume missing' } })
  );
  expectNativeCliOutputContract(events);
  expect(events).toEqual([
    { type: 'provider_error', payload: { responseId: 3, code: -32000, message: 'resume missing' } }
  ]);
});

test('Codex adapter echoes a numeric approval request id back to the app server', () => {
  const writes: string[] = [];
  const handle = {
    launchMode: 'app-server' as const,
    providerSessionRef: 'codex-thread-1',
    nextRequestId: () => 7,
    appServer: {
      send(input: string) {
        writes.push(input);
      },
      close() {}
    },
    kill() {}
  };

  // The host stringifies the numeric server-request id for transport but preserves the original on
  // the stored request payload; the response must carry the numeric id so codex can correlate it.
  codexNativeCliAdapter.resolveApproval(handle, {
    requestId: '17',
    allow: true,
    request: { kind: 'commandExecution', requestId: 17 }
  });

  expect(JSON.parse(writes[0] ?? '')).toEqual({ id: 17, result: { decision: 'accept' } });
});

test('Codex adapter requests and parses paged app-server history without rollout files', () => {
  const writes: string[] = [];
  const handle = {
    launchMode: 'app-server' as const,
    providerSessionRef: 'codex-thread-1',
    appServer: {
      send(input: string) {
        writes.push(input);
      },
      close() {}
    },
    nextRequestId: () => 9,
    kill() {}
  };

  const responseId = codexNativeCliAdapter.requestHistoryPage?.(handle, {
    limit: 3,
    cursor: 'cursor-1',
    sortDirection: 'desc',
    itemsView: 'summary'
  });
  expect(responseId).toBe(9);
  expect(JSON.parse(writes[0] ?? '')).toEqual({
    method: 'thread/turns/list',
    id: 9,
    params: {
      threadId: 'codex-thread-1',
      limit: 3,
      cursor: 'cursor-1',
      sortDirection: 'desc',
      itemsView: 'summary'
    }
  });

  const events = codexNativeCliAdapter.parseOutput(
    JSON.stringify({
      id: 9,
      result: {
        data: [{ id: 'turn-1', items: [] }],
        nextCursor: 'next-1',
        backwardsCursor: null
      }
    })
  );
  expectNativeCliOutputContract(events);
  expect(events).toEqual([
    {
      type: 'history_page',
      payload: {
        responseId: 9,
        items: [{ id: 'turn-1', items: [] }],
        nextCursor: 'next-1',
        backwardsCursor: null
      }
    }
  ]);
});

test('Codex adapter parses lightweight app-server status notifications into a provider session ref', () => {
  const chunk = JSON.stringify({
    method: 'thread/status/changed',
    params: {
      threadId: 'codex-thread-status',
      status: { type: 'idle' }
    }
  });

  const events = codexNativeCliAdapter.parseOutput(chunk);
  expectNativeCliOutputContract(events);
  expect(events).toEqual([
    {
      type: 'session_ref',
      payload: {
        providerSessionRef: 'codex-thread-status',
        status: { type: 'idle' }
      }
    }
  ]);
});

test('Codex adapter parses app-server provider-owned approval requests and resolutions', () => {
  const chunk = [
    JSON.stringify({
      method: 'item/commandExecution/requestApproval',
      id: 17,
      params: {
        threadId: 'thr_123',
        turnId: 'turn_456',
        itemId: 'item_exec',
        startedAtMs: 1790610000000,
        environmentId: 'env_1',
        reason: 'network access',
        command: 'curl https://api.openai.com',
        cwd: '/Users/zeke/project'
      }
    }),
    JSON.stringify({
      method: 'item/fileChange/requestApproval',
      id: 'req_file',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_456',
        itemId: 'item_file',
        startedAtMs: 1790610001000,
        reason: 'write package files',
        grantRoot: '/Users/zeke/project'
      }
    }),
    JSON.stringify({
      method: 'item/permissions/requestApproval',
      id: 'req_permissions',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_456',
        itemId: 'item_permissions',
        startedAtMs: 1790610002000,
        reason: 'run command',
        cwd: '/Users/zeke/project',
        environmentId: 'env_1',
        permissions: [{ type: 'exec' }]
      }
    }),
    JSON.stringify({
      method: 'execCommandApproval',
      id: 'req_legacy_exec',
      params: {
        conversationId: 'thr_legacy',
        callId: 'call_exec',
        approvalId: 'approval_exec',
        reason: 'legacy exec',
        command: ['git', 'status'],
        cwd: '/Users/zeke/project'
      }
    }),
    JSON.stringify({
      method: 'serverRequest/resolved',
      params: {
        threadId: 'thr_123',
        requestId: 17
      }
    })
  ].join('\n');

  const events = codexNativeCliAdapter.parseOutput(chunk);
  expectNativeCliOutputContract(events);
  expect(events).toEqual([
    {
      type: 'approval_requested',
      payload: {
        requestId: 17,
        kind: 'commandExecution',
        threadId: 'thr_123',
        turnId: 'turn_456',
        itemId: 'item_exec',
        startedAtMs: 1790610000000,
        reason: 'network access',
        command: 'curl https://api.openai.com',
        cwd: '/Users/zeke/project',
        environmentId: 'env_1'
      }
    },
    {
      type: 'approval_requested',
      payload: {
        requestId: 'req_file',
        kind: 'fileChange',
        threadId: 'thr_123',
        turnId: 'turn_456',
        itemId: 'item_file',
        startedAtMs: 1790610001000,
        reason: 'write package files',
        grantRoot: '/Users/zeke/project'
      }
    },
    {
      type: 'approval_requested',
      payload: {
        requestId: 'req_permissions',
        kind: 'permissions',
        threadId: 'thr_123',
        turnId: 'turn_456',
        itemId: 'item_permissions',
        startedAtMs: 1790610002000,
        reason: 'run command',
        cwd: '/Users/zeke/project',
        environmentId: 'env_1',
        permissions: [{ type: 'exec' }]
      }
    },
    {
      type: 'approval_requested',
      payload: {
        requestId: 'req_legacy_exec',
        kind: 'execCommand',
        threadId: 'thr_legacy',
        callId: 'call_exec',
        approvalId: 'approval_exec',
        reason: 'legacy exec',
        command: 'git status',
        cwd: '/Users/zeke/project'
      }
    },
    {
      type: 'approval_resolved',
      payload: {
        requestId: 17,
        threadId: 'thr_123'
      }
    }
  ]);
});

test('Codex adapter accepts Monad input and approval decisions through its app-server bridge', () => {
  const writes: string[] = [];
  const handle = {
    launchMode: 'app-server' as const,
    providerSessionRef: 'codex-thread-1',
    nextRequestId: () => 7,
    appServer: {
      send(input: string) {
        writes.push(input);
      },
      close() {}
    },
    kill() {}
  };

  codexNativeCliAdapter.sendInput(handle, 'summarize');
  codexNativeCliAdapter.resolveApproval(handle, {
    requestId: 'req_provider_1',
    allow: true,
    request: { kind: 'commandExecution' }
  });

  expect(writes).toHaveLength(2);
  expect(writes.every((line) => line.endsWith('\n'))).toBe(true);
});

test('Claude Code adapter parses stream-json messages into structured events', () => {
  const chunk = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
      cwd: '/tmp/project'
    }),
    JSON.stringify({
      type: 'assistant',
      session_id: 'claude-session-1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '我会检查文件。' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/project/a.ts' } }
        ]
      }
    }),
    JSON.stringify({
      type: 'user',
      session_id: 'claude-session-1',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' }]
      }
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'claude-session-1',
      result: '检查完成。'
    })
  ].join('\n');

  const events = claudeCodeNativeCliAdapter.parseOutput(chunk);
  expectNativeCliOutputContract(events);
  expect(events).toEqual([
    {
      type: 'session_ref',
      payload: { providerSessionRef: 'claude-session-1', cwd: '/tmp/project' }
    },
    { type: 'agent_message', payload: { text: '我会检查文件。' } },
    {
      type: 'tool_call',
      payload: {
        callId: 'toolu_1',
        tool: 'Read',
        input: { file_path: '/tmp/project/a.ts' }
      }
    },
    {
      type: 'tool_result',
      payload: {
        callId: 'toolu_1',
        output: 'file body'
      }
    },
    { type: 'agent_message', payload: { text: '检查完成。', final: true } }
  ]);
});

test('Claude Code adapter surfaces permission denials as provider errors', () => {
  const chunk = JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'claude-session-1',
    result: 'The `monad project` commands are still blocked.',
    permission_denials: [
      {
        tool_name: 'Bash',
        tool_input: {
          command: 'monad project inbox check',
          description: 'Check project inbox'
        }
      }
    ]
  });

  const events = claudeCodeNativeCliAdapter.parseOutput(chunk);
  expectNativeCliOutputContract(events);
  expect(events).toEqual([
    {
      type: 'agent_message',
      payload: { text: 'The `monad project` commands are still blocked.', final: true }
    },
    {
      type: 'provider_error',
      payload: {
        code: 'permission_denied',
        message: 'The `monad project` commands are still blocked.\n\nBlocked command: Bash: monad project inbox check'
      }
    }
  ]);
});

test('native CLI process killer targets the process group on Unix and falls back to pid kill', () => {
  const calls: Array<[number, NodeJS.Signals]> = [];
  killNativeCliProcess(
    123,
    'SIGTERM',
    (pid, signal) => {
      calls.push([pid, signal]);
      if (pid < 0) throw new Error('missing process group');
    },
    'darwin'
  );

  expect(calls).toEqual([
    [-123, 'SIGTERM'],
    [123, 'SIGTERM']
  ]);
});

test('native CLI process killer kills the whole tree on Windows', () => {
  const calls: Array<[number, NodeJS.Signals]> = [];
  const treeKills: number[] = [];
  killNativeCliProcess(
    123,
    'SIGTERM',
    (pid, signal) => calls.push([pid, signal]),
    'win32',
    (pid) => treeKills.push(pid)
  );

  expect(treeKills).toEqual([123]);
  expect(calls).toEqual([]);
});

test('native CLI process killer falls back to direct pid kill when Windows tree-kill fails', () => {
  const calls: Array<[number, NodeJS.Signals]> = [];
  killNativeCliProcess(
    123,
    'SIGTERM',
    (pid, signal) => calls.push([pid, signal]),
    'win32',
    () => {
      throw new Error('taskkill missing');
    }
  );

  expect(calls).toEqual([[123, 'SIGTERM']]);
});

test('native CLI process killer ignores already-dead POSIX process groups', () => {
  const calls: Array<[number, NodeJS.Signals]> = [];
  expect(() =>
    killNativeCliProcess(
      123,
      'SIGTERM',
      (pid, signal) => {
        calls.push([pid, signal]);
        const error = new Error('No such process') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      },
      'darwin'
    )
  ).not.toThrow();

  expect(calls).toEqual([[-123, 'SIGTERM']]);
});

test('native CLI process killer ignores already-dead direct fallback pids', () => {
  const calls: Array<[number, NodeJS.Signals]> = [];
  expect(() =>
    killNativeCliProcess(
      123,
      'SIGTERM',
      (pid, signal) => {
        calls.push([pid, signal]);
        const error = new Error('kill failed') as NodeJS.ErrnoException;
        error.code = pid < 0 ? 'EPERM' : 'ESRCH';
        throw error;
      },
      'darwin'
    )
  ).not.toThrow();

  expect(calls).toEqual([
    [-123, 'SIGTERM'],
    [123, 'SIGTERM']
  ]);
});

test('OpenClaw adapter launches the interactive CLI in pty mode rooted at the working path', () => {
  const launch = buildNativeCliLaunch(openClawAgent, { workingPath: '/tmp/project', launchMode: 'pty' });

  expect(launch.argv).toEqual(['openclaw']);
  expect(launch.cwd).toBe('/tmp/project');
  expect(launch.launchMode).toBe('pty');
  expect(launch.capabilities).toContain('pty');
  expect(launch.capabilities).toContain('session-resume');
  expect(launch.approvalOwnership).toBe('provider-owned');
});

test('OpenClaw adapter launches the gateway over a ws app-server transport', () => {
  const launch = buildNativeCliLaunch(openClawAgent, {
    workingPath: '/tmp/project',
    launchMode: 'app-server'
  });

  expect(launch.argv).toEqual(['openclaw', 'gateway']);
  expect(launch.appServerTransport).toBe('ws');
  expect(launch.capabilities).toContain('app-server');
  expect(launch.capabilities).toContain('approval-resolution');
});

test('OpenClaw adapter passes model, session ref, and dangerous-mode approval skip to launch', () => {
  const launch = buildNativeCliLaunch(openClawAgent, {
    workingPath: '/tmp/project',
    launchMode: 'pty',
    providerSessionRef: 'oc-1',
    modelId: 'openclaw-default',
    skipProviderApprovals: true
  });

  expect(launch.argv).toEqual(['openclaw', '--session-id', 'oc-1', '--model', 'openclaw-default', '--auto-approve']);
});

test('OpenClaw adapter rejects an unsupported app-server transport', () => {
  expect(() =>
    buildNativeCliLaunch(openClawAgent, {
      workingPath: '/tmp/project',
      launchMode: 'app-server',
      appServerTransport: 'stdio'
    })
  ).toThrow(/not supported/);
});

test('OpenClaw preset advertises pty + app-server and a ws transport', () => {
  const preset = openClawNativeCliAdapter.detect({ which: () => '/bin/openclaw', exists: () => false });

  expect(preset.id).toBe('openclaw');
  expect(preset.productIcon).toBe('openclaw');
  expect(preset.command).toBe('openclaw');
  expect(preset.installUrl).toBe('https://docs.openclaw.ai');
  expect(preset.supportedLaunchModes).toEqual(['pty', 'app-server']);
  expect(preset.supportedAppServerTransports).toEqual(['ws']);
});

test('OpenClaw adapter surfaces pty terminal output as plain agent messages', () => {
  const events = openClawNativeCliAdapter.parseOutput('working on it...\n', {
    launchMode: 'pty',
    kill() {}
  });
  expectNativeCliOutputContract(events);
  expect(events).toEqual([{ type: 'agent_message', payload: { text: 'working on it...\n' } }]);
  expect(openClawNativeCliAdapter.parseOutput('', { launchMode: 'pty', kill() {} })).toEqual([]);
});

test('OpenClaw adapter maps app-server ws JSON-RPC frames to the native CLI contract', () => {
  const chunk = [
    JSON.stringify({ method: 'agent.token', params: { text: 'Hello' } }),
    JSON.stringify({ method: 'agent.token', params: { delta: ' world' } }),
    JSON.stringify({
      method: 'approval.request',
      id: 'req-1',
      params: { kind: 'command', command: 'ls', cwd: '/tmp/project' }
    }),
    JSON.stringify({ method: 'agent.final', params: { text: 'Done.' } })
  ].join('\n');

  const events = openClawNativeCliAdapter.parseOutput(chunk, { launchMode: 'app-server', kill() {} });
  expectNativeCliOutputContract(events);
  expect(events).toEqual([
    { type: 'agent_message', payload: { text: 'Hello' } },
    { type: 'agent_message', payload: { text: ' world' } },
    {
      type: 'approval_requested',
      payload: { requestId: 'req-1', kind: 'command', command: 'ls', cwd: '/tmp/project' }
    },
    { type: 'agent_message', payload: { text: 'Done.', final: true } }
  ]);
});

test('OpenClaw adapter defers session start until the initialize response and resolves the session ref', () => {
  const writes: string[] = [];
  let seq = 0;
  const handle = {
    launchMode: 'app-server' as const,
    appServer: {
      send(input: string) {
        writes.push(input);
      },
      close() {}
    },
    pendingRequests: new Map<string | number, string>(),
    deferredThreadFrame: undefined as string | undefined,
    providerSessionRef: undefined as string | undefined,
    nextRequestId: () => seq++,
    kill() {}
  };

  openClawNativeCliAdapter.initialize?.(handle, { workingPath: '/tmp/project', modelId: 'openclaw-default' });
  expect(writes.map((line) => (JSON.parse(line) as { method: string }).method)).toEqual(['initialize', 'initialized']);
  expect(handle.deferredThreadFrame).toBeTruthy();

  // The initialize response (id 0) releases the parked session.start frame.
  openClawNativeCliAdapter.parseOutput(JSON.stringify({ id: 0, result: {} }), handle);
  const methods = writes.map((line) => (JSON.parse(line) as { method?: string }).method).filter(Boolean);
  expect(methods).toEqual(['initialize', 'initialized', 'session.start']);
  expect(handle.deferredThreadFrame).toBeUndefined();

  // The session.start response (id 1) resolves the provider session ref.
  const refEvents = openClawNativeCliAdapter.parseOutput(
    JSON.stringify({ id: 1, result: { sessionId: 'oc-session-9' } }),
    handle
  );
  expect(refEvents).toEqual([{ type: 'session_ref', payload: { providerSessionRef: 'oc-session-9', responseId: 1 } }]);
});

test('OpenClaw adapter sends a turn and resolves an approval over the app-server bridge', () => {
  const writes: string[] = [];
  const handle = {
    launchMode: 'app-server' as const,
    providerSessionRef: 'oc-session-9',
    appServer: {
      send(input: string) {
        writes.push(input);
      },
      close() {}
    },
    pendingRequests: new Map<string | number, string>(),
    nextRequestId: () => 7,
    kill() {}
  };

  openClawNativeCliAdapter.sendInput(handle, 'summarize the repo');
  expect(JSON.parse(writes[0] ?? '')).toEqual({
    method: 'agent.message',
    id: 7,
    params: { sessionId: 'oc-session-9', text: 'summarize the repo' }
  });

  openClawNativeCliAdapter.resolveApproval(handle, { requestId: 'req-1', allow: true });
  expect(JSON.parse(writes[1] ?? '')).toEqual({ id: 'req-1', result: { decision: 'approve' } });
});

test('OpenClaw adapter routes a failed session start to a reconnect prompt', () => {
  const handle = {
    launchMode: 'app-server' as const,
    pendingRequests: new Map<string | number, string>([[2, 'sessionStart']]),
    appServer: { send() {}, close() {} },
    nextRequestId: () => 3,
    kill() {}
  };
  expect(
    openClawNativeCliAdapter.parseOutput(
      JSON.stringify({ id: 2, error: { code: 'NoAuth', message: 'sign in first' } }),
      handle
    )
  ).toEqual([{ type: 'connection_required', payload: { code: 'NoAuth', reason: 'sign in first' } }]);
});

test('OpenClaw and Hermes auth launches use provider-owned login and status commands', () => {
  expect(buildNativeCliAuthLaunch(openClawAgent).argv).toEqual(['openclaw', 'auth']);
  expect(buildNativeCliAuthStatusLaunch(openClawAgent).argv).toEqual(['openclaw', 'auth', 'status', '--json']);
  expect(buildNativeCliAuthLaunch(hermesAgent).argv).toEqual(['hermes', 'auth']);
  expect(buildNativeCliAuthStatusLaunch(hermesAgent).argv).toEqual(['hermes', 'auth', 'list', '--json']);
});

test('OpenClaw and Hermes auth status parsers use structured output or status exit codes', () => {
  expect(openClawNativeCliAdapter.parseAuthStatus(JSON.stringify({ authenticated: true }), 0)).toBe('authenticated');
  expect(openClawNativeCliAdapter.parseAuthStatus('logged in', 0)).toBe('authenticated');
  expect(openClawNativeCliAdapter.parseAuthStatus('not signed in', 1)).toBe('unauthenticated');
  expect(openClawNativeCliAdapter.parseAuthStatus('', null)).toBe('unknown');
  expect(hermesNativeCliAdapter.parseAuthStatus(JSON.stringify({ state: 'authenticated' }), 0)).toBe('authenticated');
  expect(hermesNativeCliAdapter.parseAuthStatus('signed in as zeke', 0)).toBe('authenticated');
  expect(hermesNativeCliAdapter.parseAuthStatus('no accounts', 1)).toBe('unauthenticated');
});

test('Hermes adapter launches interactive pty and the serve backend over ws', () => {
  const pty = buildNativeCliLaunch(hermesAgent, { workingPath: '/tmp/project', launchMode: 'pty' });
  const serve = buildNativeCliLaunch(hermesAgent, { workingPath: '/tmp/project', launchMode: 'app-server' });

  expect(pty.argv).toEqual(['hermes']);
  expect(pty.launchMode).toBe('pty');
  expect(serve.argv).toEqual(['hermes', 'serve']);
  expect(serve.appServerTransport).toBe('ws');
  expect(serve.capabilities).toContain('app-server');
});

test('Hermes preset advertises pty + app-server and a ws transport', () => {
  const preset = hermesNativeCliAdapter.detect({ which: () => '/bin/hermes', exists: () => false });

  expect(preset.id).toBe('hermes');
  expect(preset.productIcon).toBe('hermes');
  expect(preset.command).toBe('hermes');
  expect(preset.installUrl).toBe('https://hermes-agent.nousresearch.com');
  expect(preset.supportedLaunchModes).toEqual(['pty', 'app-server']);
  expect(preset.supportedAppServerTransports).toEqual(['ws']);
});

test('Hermes adapter surfaces pty plain-text output as agent messages', () => {
  const events = hermesNativeCliAdapter.parseOutput('the answer is 42', { launchMode: 'pty', kill() {} });
  expectNativeCliOutputContract(events);
  expect(events).toEqual([{ type: 'agent_message', payload: { text: 'the answer is 42' } }]);
});

test('Hermes adapter maps app-server ws JSON-RPC frames and frames a turn as agent.chat', () => {
  const parsed = hermesNativeCliAdapter.parseOutput(
    [
      JSON.stringify({ method: 'agent.token', params: { token: 'Thinking' } }),
      JSON.stringify({ method: 'agent.final', params: { reply: 'Final answer.' } })
    ].join('\n'),
    { launchMode: 'app-server', kill() {} }
  );
  expectNativeCliOutputContract(parsed);
  expect(parsed).toEqual([
    { type: 'agent_message', payload: { text: 'Thinking' } },
    { type: 'agent_message', payload: { text: 'Final answer.', final: true } }
  ]);

  const writes: string[] = [];
  const handle = {
    launchMode: 'app-server' as const,
    providerSessionRef: 'hermes-1',
    appServer: {
      send(input: string) {
        writes.push(input);
      },
      close() {}
    },
    pendingRequests: new Map<string | number, string>(),
    nextRequestId: () => 4,
    kill() {}
  };
  hermesNativeCliAdapter.sendInput(handle, 'what changed?');
  expect(JSON.parse(writes[0] ?? '')).toEqual({
    method: 'agent.chat',
    id: 4,
    params: { sessionId: 'hermes-1', prompt: 'what changed?' }
  });
});

test('OpenClaw and Hermes adapters ignore malformed output and unknown notifications', () => {
  const appServer = { send() {}, close() {} };
  expect(
    openClawNativeCliAdapter.parseOutput('not-json\n{"method":"unknown/event","params":{}}\n', {
      launchMode: 'app-server',
      appServer,
      kill() {}
    })
  ).toEqual([]);
  expect(
    hermesNativeCliAdapter.parseOutput('not-json\n{"method":"unknown/event","params":{}}\n', {
      launchMode: 'app-server',
      appServer,
      kill() {}
    })
  ).toEqual([]);
});

test('OpenClaw and Hermes adapters auto-decline an unknown server-initiated request', () => {
  const writes: string[] = [];
  const handle = {
    launchMode: 'app-server' as const,
    appServer: {
      send(input: string) {
        writes.push(input);
      },
      close() {}
    },
    pendingRequests: new Map<string | number, string>(),
    nextRequestId: () => 1,
    kill() {}
  };

  const events = openClawNativeCliAdapter.parseOutput(
    JSON.stringify({ method: 'tool/requestUserInput', id: 42, params: {} }),
    handle
  );
  expect(events).toEqual([]);
  expect(JSON.parse(writes[0] ?? '')).toEqual({
    id: 42,
    error: { code: -32601, message: 'Unsupported method: tool/requestUserInput' }
  });
});

// Managed project-agent runtime: OpenClaw & Hermes join Workplace projects as supervised members and
// call back with `monad project post/ask/read`. They declare a managedRuntime so the daemon reads
// their launch mode + prompt-delivery intent from the adapter (no provider branching), and they use
// the shared `monad` wrapper callback — NOT the managed MCP bridge (codex-only) — riding the existing
// native-cli managed-project auth.
test('hermes managedRuntime enables the project callback via app-server + developer instructions', () => {
  const managed = hermesNativeCliAdapter.managedRuntime;
  expect(managed).toBeDefined();
  expect(managed?.launchMode?.('pty')).toBe('app-server');
  expect(managed?.usesDeveloperInstructions).toBe(true);
  // Wrapper callback, not the managed MCP bridge → no mcp config args injected.
  expect(managed?.usesManagedMcpBridge ?? false).toBe(false);
  expect(managed?.mcpConfigArgs).toBeUndefined();
});

test('openclaw managedRuntime enables the project callback via app-server + developer instructions', () => {
  const managed = openClawNativeCliAdapter.managedRuntime;
  expect(managed).toBeDefined();
  expect(managed?.launchMode?.('pty')).toBe('app-server');
  expect(managed?.usesDeveloperInstructions).toBe(true);
  expect(managed?.usesManagedMcpBridge ?? false).toBe(false);
  expect(managed?.mcpConfigArgs).toBeUndefined();
});

test('OpenClaw agent.final without a text field still yields a final agent_message', () => {
  const events = openClawNativeCliAdapter.parseOutput(JSON.stringify({ method: 'agent.final', params: {} }), {
    launchMode: 'app-server',
    kill() {}
  });
  expectNativeCliOutputContract(events);
  expect(events).toEqual([{ type: 'agent_message', payload: { text: '', final: true } }]);
});

test('Hermes agent.final without a text field still yields a final agent_message', () => {
  const events = hermesNativeCliAdapter.parseOutput(
    JSON.stringify({ method: 'agent.final', params: { final: true } }),
    { launchMode: 'app-server', kill() {} }
  );
  expectNativeCliOutputContract(events);
  expect(events).toEqual([{ type: 'agent_message', payload: { text: '', final: true } }]);
});

test('OpenClaw session.updated with an empty-string sessionId emits nothing (no invalid session_ref)', () => {
  const empty = openClawNativeCliAdapter.parseOutput(
    JSON.stringify({ method: 'session.updated', params: { sessionId: '' } }),
    { launchMode: 'app-server', kill() {} }
  );
  expect(empty).toEqual([]);

  const valid = openClawNativeCliAdapter.parseOutput(
    JSON.stringify({ method: 'session.updated', params: { sessionId: 'oc-2' } }),
    { launchMode: 'app-server', kill() {} }
  );
  expectNativeCliOutputContract(valid);
  expect(valid).toEqual([{ type: 'session_ref', payload: { providerSessionRef: 'oc-2' } }]);
});

test('OpenClaw approval.resolved falls back to params.id and drops an id-less resolution', () => {
  const viaId = openClawNativeCliAdapter.parseOutput(
    JSON.stringify({ method: 'approval.resolved', params: { id: 'req-9' } }),
    { launchMode: 'app-server', kill() {} }
  );
  expectNativeCliOutputContract(viaId);
  expect(viaId).toEqual([{ type: 'approval_resolved', payload: { requestId: 'req-9' } }]);

  const idLess = openClawNativeCliAdapter.parseOutput(JSON.stringify({ method: 'approval.resolved', params: {} }), {
    launchMode: 'app-server',
    kill() {}
  });
  expect(idLess).toEqual([]);
});

test('OpenClaw approval.request with no frame id falls back to a routable params id', () => {
  const events = openClawNativeCliAdapter.parseOutput(
    JSON.stringify({ method: 'approval.request', params: { requestId: 'ar-1', kind: 'command' } }),
    { launchMode: 'app-server', kill() {} }
  );
  expectNativeCliOutputContract(events);
  expect(events).toEqual([{ type: 'approval_requested', payload: { requestId: 'ar-1', kind: 'command' } }]);

  const unroutable = openClawNativeCliAdapter.parseOutput(
    JSON.stringify({ method: 'approval.request', params: { kind: 'command' } }),
    { launchMode: 'app-server', kill() {} }
  );
  expect(unroutable).toEqual([]);
});

test('OpenClaw does NOT auto-decline a known notification that carries an id but yields no events', () => {
  const writes: string[] = [];
  const handle = {
    launchMode: 'app-server' as const,
    appServer: {
      send(input: string) {
        writes.push(input);
      },
      close() {}
    },
    pendingRequests: new Map<string | number, string>(),
    nextRequestId: () => 1,
    kill() {}
  };

  // session.updated is a KNOWN notification; an empty sessionId legitimately yields zero events. A
  // classifier keyed on "produced events" would wrongly reply -32601 just because it carries an id.
  const events = openClawNativeCliAdapter.parseOutput(
    JSON.stringify({ method: 'session.updated', id: 5, params: { sessionId: '' } }),
    handle
  );
  expect(events).toEqual([]);
  expect(writes).toEqual([]);
});
