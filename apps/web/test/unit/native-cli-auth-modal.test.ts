import type { NativeCliAuthSessionView } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { nativeCliAuthSessionForView } from '../../features/workplace/cli/NativeCliAuthModal';

const authSession = (overrides: Partial<NativeCliAuthSessionView> = {}): NativeCliAuthSessionView => ({
  id: 'ncliauth_01KWAUTH000000000000000',
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
  const source = readFileSync('apps/web/features/workplace/cli/CliTerminalModal.tsx', 'utf8');

  expect(source).toContain('key={id}');
});

test('native CLI auth callers clear the previous connect window before starting another provider', () => {
  const workplace = readFileSync('apps/web/features/workplace/Workplace.tsx', 'utf8');
  const settings = readFileSync('apps/web/features/settings/NativeCliAgentsSettings.tsx', 'utf8');

  expect(workplace).toContain('setNativeCliAuthSession(null);');
  expect(settings).toContain('setAuthSession(null);');
});
