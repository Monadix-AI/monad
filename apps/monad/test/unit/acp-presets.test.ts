// Invite presets for same-machine third-party agents (Codex / Claude Code) + same-machine detection.
// The detection probes are injected so the codex-not-on-PATH app-bundle fallback is deterministic.

import type { BinProbes } from '#/infra/resolve-binary.ts';

import { expect, test } from 'bun:test';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';

import { listAcpAgentPresets } from '#/services/delegation/presets.ts';
import { registerAgentAdapterImpl } from '#/services/external-agent/index.ts';

// ACP invite presets now derive from the agent-adapter registry (adapters that declare an `acp`
// delivery variant); the daemon populates it at boot, so register the built-ins for this unit test.
for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

const CODEX_APP_BIN = '/Applications/Codex.app/Contents/Resources/codex';

// Probes that find nothing — every preset reports not-installed.
const none: BinProbes = { which: () => undefined, exists: () => false };

test('catalog: claude-code + codex presets target their official ACP adapters', () => {
  const presets = listAcpAgentPresets(none);
  expect(presets.map((p) => p.id).sort()).toEqual(['claude-code', 'codex']);
  for (const p of presets) {
    expect(p.command).toBe('npx');
    expect(p.installHint.length).toBeGreaterThan(0);
  }
  // biome-ignore lint/style/noNonNullAssertion: test invariant — preset must exist
  const claude = presets.find((p) => p.id === 'claude-code')!;
  // biome-ignore lint/style/noNonNullAssertion: test invariant — preset must exist
  const codex = presets.find((p) => p.id === 'codex')!;
  // pinned to a specific version (`@x.y.z`) so npx can't pull a breaking `latest`
  expect(claude.args.some((a) => /^@agentclientprotocol\/claude-agent-acp@\d/.test(a))).toBe(true);
  expect(codex.args.some((a) => /^@agentclientprotocol\/codex-acp@\d/.test(a))).toBe(true);
});

test('detection: nothing present → not installed, no resolved bin', () => {
  // biome-ignore lint/style/noNonNullAssertion: test invariant — preset must exist
  const codex = listAcpAgentPresets(none).find((p) => p.id === 'codex')!;
  expect(codex.installed).toBe(false);
});

test('detection: claude-code found on PATH', () => {
  const probes: BinProbes = {
    which: (b) => (b === 'claude' ? '/usr/local/bin/claude' : undefined),
    exists: () => false
  };
  // biome-ignore lint/style/noNonNullAssertion: test invariant — preset must exist
  const claude = listAcpAgentPresets(probes).find((p) => p.id === 'claude-code')!;
  expect(claude.installed).toBe(true);
  expect(claude.resolvedBinPath).toBe('/usr/local/bin/claude');
});

test('detection: codex NOT on PATH but present in the Codex.app bundle → installed via fallback', () => {
  // The whole point of the app-bundle fallback: `which codex` misses, the bundle path exists.
  const probes: BinProbes = { which: () => undefined, exists: (p) => p === CODEX_APP_BIN };
  // biome-ignore lint/style/noNonNullAssertion: test invariant — preset must exist
  const codex = listAcpAgentPresets(probes).find((p) => p.id === 'codex')!;
  expect(codex.installed).toBe(true);
  expect(codex.resolvedBinPath).toBe(CODEX_APP_BIN);
});

test('detection: login dir alone (no binary) still counts as set up', () => {
  // `join(home, '.codex')` yields a backslash-separated path on Windows, so normalize before the
  // suffix check — the probe must match the OS-native path the product actually stats.
  const probes: BinProbes = { which: () => undefined, exists: (p) => p.replaceAll('\\', '/').endsWith('/.codex') };
  // biome-ignore lint/style/noNonNullAssertion: test invariant — preset must exist
  const codex = listAcpAgentPresets(probes).find((p) => p.id === 'codex')!;
  expect(codex.installed).toBe(true);
});
