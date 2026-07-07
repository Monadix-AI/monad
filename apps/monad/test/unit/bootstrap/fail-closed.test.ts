// Security fail-closed boot guards (commit e83e66f15): the daemon must refuse to start rather than
// silently downgrade when TLS can't be provisioned for remote access, or when sandbox confinement is
// requested but no launcher is available. These branches are exactly the kind that regress quietly,
// so they get explicit coverage.

import type { MonadConfig } from '@monad/home';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultConfig, pathsForHome } from '@monad/home';

import { createSandbox, finalizeSandboxLauncher } from '@/bootstrap/sandbox.ts';
import { createTlsCert } from '@/bootstrap/tls.ts';
import {
  clearSandboxLaunchers,
  configureSandboxLauncher,
  noneLauncher,
  registerSandboxLauncher
} from '@/capabilities/tools';

let tlsDir: string;
beforeEach(async () => {
  tlsDir = await mkdtemp(join(tmpdir(), 'monad-tls-'));
  clearSandboxLaunchers();
});
afterEach(async () => {
  configureSandboxLauncher(noneLauncher);
  clearSandboxLaunchers();
  configureSandboxLauncher(noneLauncher);
  await rm(tlsDir, { recursive: true, force: true });
});

// ── TLS fail-closed ────────────────────────────────────────────────────────────
const okDeps = {
  findOpenssl: async () => '/usr/bin/openssl',
  ensureTlsCert: async (dir: string) => ({ certPath: join(dir, 'cert.pem'), keyPath: join(dir, 'key.pem') }),
  renewTlsCert: async (dir: string) => ({ certPath: join(dir, 'cert.pem'), keyPath: join(dir, 'key.pem') }),
  certExpiry: async () => new Date(Date.now() + 90 * 86_400_000).toISOString()
};

test('createTlsCert throws when openssl is missing', async () => {
  await expect(createTlsCert({ tlsDir }, { ...okDeps, findOpenssl: async () => null })).rejects.toThrow(
    /openssl is not installed/
  );
});

test('createTlsCert renews a certificate that expires inside the renewal window', async () => {
  let renewed = false;
  const out = await createTlsCert(
    { tlsDir, renewBeforeDays: 30 },
    {
      ...okDeps,
      certExpiry: async () => new Date(Date.now() + 5 * 86_400_000).toISOString(),
      renewTlsCert: async (dir: string) => {
        renewed = true;
        return { certPath: join(dir, 'cert.pem'), keyPath: join(dir, 'key.pem') };
      }
    }
  );
  expect(renewed).toBe(true);
  expect(out.warnings).toContain('tls:cert-renewed');
});

test('createTlsCert throws when cert generation fails (fail-closed)', async () => {
  await expect(
    createTlsCert(
      { tlsDir },
      {
        ...okDeps,
        ensureTlsCert: async () => {
          throw new Error('openssl exploded');
        }
      }
    )
  ).rejects.toThrow(/TLS certificate generation failed/);
});

// ── sandbox fail-closed ──────────────────────────────────────────────────────────
function sandboxConfig(over: { confine: boolean; allowUnconfinedExec?: boolean }): MonadConfig {
  const cfg = createDefaultConfig('prn_test', 'Test');
  cfg.agent.sandbox.confine = over.confine;
  cfg.agent.sandbox.allowUnconfinedExec = over.allowUnconfinedExec ?? false;
  return cfg;
}

test('finalizeSandboxLauncher throws when confine=true but no launcher is available', () => {
  // Registry is empty (cleared in beforeEach) → selectSandboxLauncher returns the none launcher.
  expect(() => finalizeSandboxLauncher(sandboxConfig({ confine: true }))).toThrow(/no sandbox launcher is available/);
});

test('finalizeSandboxLauncher allows unconfined exec only when explicitly opted in', () => {
  expect(() => finalizeSandboxLauncher(sandboxConfig({ confine: true, allowUnconfinedExec: true }))).not.toThrow();
});

test('finalizeSandboxLauncher does not throw when confinement is off', () => {
  expect(() => finalizeSandboxLauncher(sandboxConfig({ confine: false }))).not.toThrow();
});

test('finalizeSandboxLauncher accepts an available launcher without opt-in', () => {
  registerSandboxLauncher(
    { kind: 'test-seatbelt', enforces: { readDeny: true, net: ['none', 'filtered', 'unrestricted'] } },
    'builtin'
  );
  expect(() => finalizeSandboxLauncher(sandboxConfig({ confine: true }))).not.toThrow();
});

test('createSandbox boot sweep keeps Workplace Project sandbox roots alive', async () => {
  const home = await mkdtemp(join(tmpdir(), 'monad-sandbox-bootstrap-'));
  const paths = pathsForHome(home);
  const cfg = createDefaultConfig('prn_test', 'Test');
  cfg.agent.sandbox.mode = 'ephemeral';
  cfg.agent.sandbox.confine = false;

  const sandboxDir = join(paths.cache, 'sandboxes');
  await mkdir(join(sandboxDir, 'ses_live'), { recursive: true });
  await mkdir(join(sandboxDir, 'ses_project'), { recursive: true });
  await mkdir(join(sandboxDir, 'ses_dead'), { recursive: true });

  try {
    await createSandbox(cfg, paths, {
      listSessions: () => [{ id: 'ses_live' }],
      listWorkplaceProjects: () => [{ id: 'ses_project' }]
    } as never);

    expect(existsSync(join(sandboxDir, 'ses_live'))).toBe(true);
    expect(existsSync(join(sandboxDir, 'ses_project'))).toBe(true);
    expect(existsSync(join(sandboxDir, 'ses_dead'))).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
