import type { NativeCliAgentView } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseNativeCliArgumentSupport } from '@/services/native-cli/argument-support.ts';
import {
  buildNativeCliArgumentSupportProbe,
  buildNativeCliAuthLaunch,
  buildNativeCliAuthStatusLaunch,
  buildNativeCliLaunch,
  claudeCodeNativeCliAdapter,
  codexNativeCliAdapter,
  geminiNativeCliAdapter,
  listNativeCliAgentModelOptions,
  listNativeCliAgentPresets,
  qwenNativeCliAdapter,
  resolveNativeCliLaunchCommand
} from '@/services/native-cli/index.ts';
import { killNativeCliProcess } from '@/services/native-cli/process.ts';
import { normalizePtyInput } from '@/services/native-cli/pty.ts';
import { nativeCliOutputEventSchema } from '@/services/native-cli/types.ts';

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
  expect('initialMessages' in launch).toBe(false);
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
    stdin: {
      write(input: string) {
        writes.push(input);
      }
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
  expect(messages[0]?.params?.capabilities).toEqual({ experimentalApi: true });
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
    stdin: {
      write(input: string) {
        writes.push(input);
      }
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
  expect(messages[0]?.params?.capabilities).toEqual({ experimentalApi: true });
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

test('Qwen adapter launches structured stream-json mode with official output-format flag', () => {
  const launch = buildNativeCliLaunch(qwenAgent, { workingPath: '/tmp/project', launchMode: 'json-stream' });

  expect(launch.argv).toEqual(['qwen', '-p', '', '--output-format', 'stream-json']);
  expect(launch.cwd).toBe('/tmp/project');
  expect(launch.launchMode).toBe('json-stream');
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

  expect(presets.map((preset) => preset.id).sort()).toEqual(['claude-code', 'codex', 'gemini', 'qwen']);
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
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-haiku-4-5',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6'
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
  expect(claudeCodeNativeCliAdapter.listSupportedModels()).toEqual([
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-haiku-4-5',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6'
  ]);
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

test('Codex app-server turn completion is a final diagnostic event', () => {
  const events = codexNativeCliAdapter.parseOutput(
    JSON.stringify({
      method: 'turn/completed',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_456',
        result: 'No action needed.'
      }
    })
  );

  expectNativeCliOutputContract(events);
  expect(events).toEqual([{ type: 'agent_message', payload: { text: 'No action needed.', final: true } }]);
});

test('Gemini adapter translates stream-json events into the Monad native CLI contract', () => {
  const chunk = [
    JSON.stringify({ type: 'init', session_id: 'gemini-session-1', model: 'gemini-2.5-pro' }),
    JSON.stringify({ type: 'message', role: 'assistant', text: 'I will inspect the project.' }),
    JSON.stringify({ type: 'tool_use', id: 'tool-1', name: 'read_file', args: { path: 'README.md' } }),
    JSON.stringify({ type: 'tool_result', id: 'tool-1', output: 'README contents' }),
    JSON.stringify({ type: 'result', response: 'Done.' })
  ].join('\n');

  const events = geminiNativeCliAdapter.parseOutput(chunk);
  expectNativeCliOutputContract(events);
  expect(events).toEqual([
    { type: 'session_ref', payload: { providerSessionRef: 'gemini-session-1', model: 'gemini-2.5-pro' } },
    { type: 'agent_message', payload: { text: 'I will inspect the project.' } },
    { type: 'tool_call', payload: { callId: 'tool-1', tool: 'read_file', input: { path: 'README.md' } } },
    { type: 'tool_result', payload: { callId: 'tool-1', output: 'README contents' } },
    { type: 'agent_message', payload: { text: 'Done.', final: true } }
  ]);
});

test('Qwen adapter translates stream-json events into the Monad native CLI contract', () => {
  const chunk = [
    JSON.stringify({ type: 'init', session_id: 'qwen-session-1', model: 'qwen3-coder' }),
    JSON.stringify({ type: 'message', role: 'assistant', text: 'I will inspect the project.' }),
    JSON.stringify({ type: 'tool_use', id: 'tool-1', name: 'read_file', args: { path: 'README.md' } }),
    JSON.stringify({ type: 'tool_result', id: 'tool-1', output: 'README contents' }),
    JSON.stringify({ type: 'result', response: 'Done.' })
  ].join('\n');

  const events = qwenNativeCliAdapter.parseOutput(chunk);
  expectNativeCliOutputContract(events);
  expect(events).toEqual([
    { type: 'session_ref', payload: { providerSessionRef: 'qwen-session-1', model: 'qwen3-coder' } },
    { type: 'agent_message', payload: { text: 'I will inspect the project.' } },
    { type: 'tool_call', payload: { callId: 'tool-1', tool: 'read_file', input: { path: 'README.md' } } },
    { type: 'tool_result', payload: { callId: 'tool-1', output: 'README contents' } },
    { type: 'agent_message', payload: { text: 'Done.', final: true } }
  ]);
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

test('Codex adapter requests and parses paged app-server history without rollout files', () => {
  const writes: string[] = [];
  const handle = {
    launchMode: 'app-server' as const,
    providerSessionRef: 'codex-thread-1',
    stdin: {
      write(input: string) {
        writes.push(input);
      }
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
    stdin: {
      write(input: string) {
        writes.push(input);
      }
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
