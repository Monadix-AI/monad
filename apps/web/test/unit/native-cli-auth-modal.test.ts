import type { NativeCliAuthSessionView } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { nativeCliAuthSessionForView } from '../../features/workplace/cli/NativeCliAuthModal';

const readSource = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const authSession = (overrides: Partial<NativeCliAuthSessionView> = {}): NativeCliAuthSessionView => ({
  id: 'ncliauth_01KWAUTH000000000000000',
  controlToken: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  agentName: 'codex',
  provider: 'codex',
  approvalOwnership: 'provider-owned',
  authState: 'unknown',
  state: 'running',
  pid: 1234,
  outputSnapshot: '',
  exitCode: null,
  startedAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  exitedAt: null,
  ...overrides
});

test('native CLI auth modal ignores stale query data from a previous connect session', () => {
  expect(
    nativeCliAuthSessionForView(
      'ncliauth_01KWNEW000000000000000',
      authSession({
        id: 'ncliauth_01KWOLD000000000000000',
        outputSnapshot: 'old connect output'
      })
    )
  ).toBeUndefined();
});

test('native CLI auth modal accepts query data for the active connect session', () => {
  const session = authSession({
    id: 'ncliauth_01KWNEW000000000000000',
    outputSnapshot: 'new connect output'
  });

  expect(nativeCliAuthSessionForView('ncliauth_01KWNEW000000000000000', session)).toBe(session);
});

test('native CLI auth terminal remounts when the connect session changes', () => {
  const source = readSource('features/workplace/cli/CliTerminalModal.tsx');

  expect(source).toContain('key={id}');
});

test('native CLI settings clears the previous connect window before starting another provider', () => {
  const settings = readSource('features/studio/third-party-agents/NativeCliAgentsSettings.tsx');

  expect(settings).toContain('setAuthSession(null);');
});
