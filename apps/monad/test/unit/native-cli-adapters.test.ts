import type { NativeCliAgentView } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  buildNativeCliAuthLaunch,
  buildNativeCliAuthStatusLaunch,
  buildNativeCliLaunch,
  claudeCodeNativeCliAdapter,
  codexNativeCliAdapter,
  geminiNativeCliAdapter,
  listNativeCliAgentPresets,
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

test('Codex adapter launches app-server stdio with initialization messages', () => {
  const launch = buildNativeCliLaunch(codexAgent, { workingPath: '/tmp/project', launchMode: 'app-server' });

  expect(launch.argv).toEqual(['codex', 'app-server', '--stdio']);
  expect(launch.cwd).toBe('/tmp/project');
  expect('initialMessages' in launch).toBe(false);
});

test('native CLI auth launches provider-owned login and status commands', () => {
  expect(buildNativeCliAuthLaunch(codexAgent).argv).toEqual(['codex', 'login']);
  expect(buildNativeCliAuthStatusLaunch(codexAgent).argv).toEqual(['codex', 'login', 'status']);
  expect(buildNativeCliAuthLaunch(claudeAgent).argv).toEqual(['claude', 'auth', 'login']);
  expect(buildNativeCliAuthStatusLaunch(claudeAgent).argv).toEqual(['claude', 'auth', 'status']);
  expect(buildNativeCliAuthLaunch(geminiAgent).argv).toEqual(['gemini']);
  expect(buildNativeCliAuthStatusLaunch(geminiAgent).argv).toEqual(['gemini', '--list-sessions']);
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

  codexNativeCliAdapter.initialize?.(handle, { workingPath: '/tmp/project' });

  expect(writes).toHaveLength(3);
  expect(writes.every((line) => line.endsWith('\n'))).toBe(true);
  const messages = writes.map(
    (line) => JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> }
  );
  expect(messages[0]?.params?.capabilities).toEqual({ experimentalApi: true });
  expect(messages[2]).toEqual({
    method: 'thread/start',
    id: 2,
    params: { cwd: '/tmp/project' }
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

test('native CLI presets detect Codex, Claude Code, and Gemini as direct client commands', () => {
  const presets = listNativeCliAgentPresets({ which: (name) => `/bin/${name}`, exists: () => false });

  expect(presets.map((preset) => preset.id).sort()).toEqual(['claude-code', 'codex', 'gemini']);
  expect(presets.find((preset) => preset.id === 'codex')?.command).toBe('codex');
  expect(presets.find((preset) => preset.id === 'claude-code')?.command).toBe('claude');
  expect(presets.find((preset) => preset.id === 'gemini')?.command).toBe('gemini');
  expect(presets.find((preset) => preset.id === 'codex')?.installUrl).toBe('https://developers.openai.com/codex/cli');
  expect(presets.find((preset) => preset.id === 'claude-code')?.installUrl).toBe(
    'https://docs.anthropic.com/en/docs/claude-code/setup'
  );
  expect(presets.find((preset) => preset.id === 'gemini')?.installUrl).toBe(
    'https://github.com/google-gemini/gemini-cli'
  );
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

  expect(codexLaunch.argv[0]).toBe('/Applications/Codex.app/Contents/Resources/codex');
  expect(claudeLaunch.argv[0]).toBe('/Users/zeke/.local/bin/claude');
  expect(geminiLaunch.argv[0]).toBe('/Users/zeke/.bun/bin/gemini');
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
    { type: 'agent_message', payload: { text: 'Done.' } }
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
    { type: 'agent_message', payload: { text: '检查完成。' } }
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
