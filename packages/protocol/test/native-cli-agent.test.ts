import { expect, test } from 'bun:test';

import {
  nativeCliAgentPresetSchema,
  nativeCliAgentViewSchema,
  nativeCliApprovalResolutionRequestSchema,
  nativeCliAuthSessionViewSchema,
  nativeCliAuthStatusResponseSchema,
  nativeCliSessionViewSchema,
  startNativeCliAgentRequestSchema
} from '../src/native-cli-agent.ts';

test('native CLI agent view requires provider-owned full-capability defaults', () => {
  const parsed = nativeCliAgentViewSchema.parse({
    name: 'codex',
    provider: 'codex',
    command: 'codex',
    enabled: true,
    defaultLaunchMode: 'pty',
    allowDangerousMode: false
  });

  expect(parsed.provider).toBe('codex');
  expect(parsed.defaultLaunchMode).toBe('pty');
  expect(parsed.approvalOwnership).toBe('provider-owned');
});

test('native CLI agent view accepts Gemini as a provider-owned native CLI provider', () => {
  const parsed = nativeCliAgentViewSchema.parse({
    name: 'gemini',
    provider: 'gemini',
    command: 'gemini',
    enabled: true
  });

  expect(parsed.provider).toBe('gemini');
  expect(parsed.defaultLaunchMode).toBe('pty');
  expect(parsed.approvalOwnership).toBe('provider-owned');
});

test('native CLI preset view includes a provider install page', () => {
  const parsed = nativeCliAgentPresetSchema.parse({
    id: 'codex',
    label: 'Codex',
    provider: 'codex',
    command: 'codex',
    args: [],
    defaultLaunchMode: 'pty',
    supportedLaunchModes: ['pty'],
    installHint: 'Install Codex.',
    installUrl: 'https://developers.openai.com/codex/cli',
    installed: false
  });

  expect(parsed.installUrl).toBe('https://developers.openai.com/codex/cli');
});

test('native CLI approval resolution request carries provider request id and decision', () => {
  expect(
    nativeCliApprovalResolutionRequestSchema.parse({ requestId: 'req_1', allow: true, reason: 'approved by user' })
  ).toEqual({ requestId: 'req_1', allow: true, reason: 'approved by user' });
});

test('start request requires an absolute working path', () => {
  expect(startNativeCliAgentRequestSchema.safeParse({ agentName: 'codex', workingPath: 'relative/path' }).success).toBe(
    false
  );
  expect(startNativeCliAgentRequestSchema.safeParse({ agentName: 'codex', workingPath: '/tmp/project' }).success).toBe(
    true
  );
  expect(
    startNativeCliAgentRequestSchema.parse({
      agentName: 'codex',
      workingPath: '/tmp/project',
      providerSessionRef: 'provider-session-1'
    }).providerSessionRef
  ).toBe('provider-session-1');
});

test('native CLI session view preserves provider session lifecycle fields', () => {
  const parsed = nativeCliSessionViewSchema.parse({
    id: 'ncli_1',
    projectSessionId: 'ses_PROJECT',
    agentName: 'claude-code',
    provider: 'claude-code',
    workingPath: '/tmp/project',
    launchMode: 'pty',
    state: 'running',
    pid: 123,
    providerSessionRef: 'abc',
    outputSnapshot: 'hello',
    exitCode: null,
    startedAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:01.000Z',
    exitedAt: null
  });

  expect(parsed.approvalOwnership).toBe('provider-owned');
  expect(parsed.exitCode).toBeNull();
});

test('native CLI auth views model provider-owned login relay without project session fields', () => {
  const session = nativeCliAuthSessionViewSchema.parse({
    id: 'ncliauth_1',
    agentName: 'codex',
    provider: 'codex',
    state: 'running',
    pid: 123,
    outputSnapshot: 'Open this URL to sign in',
    exitCode: null,
    startedAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:01.000Z',
    exitedAt: null
  });
  expect(session.approvalOwnership).toBe('provider-owned');
  expect('projectSessionId' in session).toBe(false);

  expect(
    nativeCliAuthStatusResponseSchema.parse({
      agentName: 'claude-code',
      provider: 'claude-code',
      state: 'unauthenticated',
      output: 'not logged in',
      checkedAt: '2026-06-28T00:00:02.000Z'
    }).state
  ).toBe('unauthenticated');
});

// The workingPath schema is cross-platform: it travels over the wire from any client OS, so it must
// accept both POSIX and Windows absolute paths (the daemon re-checks with path.isAbsolute for its own
// platform). Relative paths are always rejected.
const startReq = (workingPath: string) =>
  startNativeCliAgentRequestSchema.safeParse({ agentName: 'codex', workingPath, launchMode: 'pty' });

test('startNativeCliAgentRequest accepts POSIX absolute working paths', () => {
  expect(startReq('/home/user/project').success).toBe(true);
  expect(startReq('/').success).toBe(true);
});

test('startNativeCliAgentRequest accepts Windows absolute working paths', () => {
  expect(startReq('C:\\Users\\me\\project').success).toBe(true);
  expect(startReq('C:/Users/me/project').success).toBe(true);
  expect(startReq('\\\\server\\share\\project').success).toBe(true);
});

test('startNativeCliAgentRequest rejects relative working paths', () => {
  for (const rel of ['project', './project', '../project', 'C:project', 'foo/bar']) {
    expect(startReq(rel).success).toBe(false);
  }
});
