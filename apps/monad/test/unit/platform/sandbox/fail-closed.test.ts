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

import { clearSandboxLaunchers, configureSandboxLauncher, noneLauncher } from '#/capabilities/tools';
import { createSandbox, finalizeSandboxLauncher } from '#/platform/sandbox/service.ts';
import { createTlsCert, resolveTlsSetupForNetwork } from '#/transports/tls.ts';

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

test('resolveTlsSetupForNetwork skips provisioning while HTTPS is disabled', async () => {
  let provisioned = false;
  const out = await resolveTlsSetupForNetwork({
    https: { enabled: false },
    tlsDir,
    provision: async () => {
      provisioned = true;
      return { cert: { certPath: 'cert.pem', keyPath: 'key.pem' }, warnings: [] };
    }
  });

  expect(provisioned).toBe(false);
  expect(out).toEqual({ warnings: ['tls:https-disabled'] });
});

test('resolveTlsSetupForNetwork reuses a current certificate when HTTPS stays enabled', async () => {
  const current = {
    cert: { certPath: 'cert.pem', keyPath: 'key.pem' },
    fingerprint: 'sha256',
    expiry: '2030-01-01T00:00:00.000Z',
    warnings: []
  };
  let provisioned = false;

  const out = await resolveTlsSetupForNetwork({
    https: { enabled: true },
    tlsDir,
    current,
    provision: async () => {
      provisioned = true;
      return { cert: { certPath: 'next-cert.pem', keyPath: 'next-key.pem' }, warnings: [] };
    }
  });

  expect(provisioned).toBe(false);
  expect(out).toBe(current);
});

test('resolveTlsSetupForNetwork provisions a certificate when HTTPS is enabled by hot reload', async () => {
  const out = await resolveTlsSetupForNetwork({
    https: { enabled: true },
    tlsDir,
    current: { warnings: ['tls:https-disabled'] },
    provision: async ({ tlsDir: dir }) => ({
      cert: { certPath: join(dir, 'cert.pem'), keyPath: join(dir, 'key.pem') },
      fingerprint: 'sha256',
      expiry: '2030-01-01T00:00:00.000Z',
      warnings: []
    })
  });

  expect(out.cert).toEqual({ certPath: join(tlsDir, 'cert.pem'), keyPath: join(tlsDir, 'key.pem') });
  expect(out.fingerprint).toBe('sha256');
});

// ── sandbox fail-closed ──────────────────────────────────────────────────────────
function sandboxConfig(over: { confine: boolean; allowUnconfinedExec?: boolean }): MonadConfig {
  const cfg = createDefaultConfig('prn_test00000000', 'Test');
  cfg.sandbox.confine = over.confine;
  cfg.sandbox.allowUnconfinedExec = over.allowUnconfinedExec ?? false;
  return cfg;
}

// 'freebsd' is not targeted by any light launcher, so auto resolves to noneLauncher deterministically
// on every CI host (macOS/Linux/Windows) — the "no launcher available for this platform" case.
const NO_LAUNCHER_PLATFORM = 'freebsd' as NodeJS.Platform;

test('finalizeSandboxLauncher throws when confine=true but no launcher is available', async () => {
  await expect(finalizeSandboxLauncher(sandboxConfig({ confine: true }), NO_LAUNCHER_PLATFORM)).rejects.toThrow(
    /no sandbox launcher confines/
  );
});

test('finalizeSandboxLauncher allows unconfined exec only when explicitly opted in', async () => {
  await finalizeSandboxLauncher(sandboxConfig({ confine: true, allowUnconfinedExec: true }), NO_LAUNCHER_PLATFORM);
});

test('finalizeSandboxLauncher does not throw when confinement is off', async () => {
  await finalizeSandboxLauncher(sandboxConfig({ confine: false }));
});

test('finalizeSandboxLauncher accepts the light launcher on a supported platform without opt-in', async () => {
  // macOS always has Seatbelt in the closed light set — auto selects it, no atom registration needed.
  await finalizeSandboxLauncher(sandboxConfig({ confine: true }), 'darwin');
});

test('createSandbox boot sweep keeps Workplace Project sandbox roots alive', async () => {
  const home = await mkdtemp(join(tmpdir(), 'monad-sandbox-runtime-'));
  const paths = pathsForHome(home);
  const cfg = createDefaultConfig('prn_test00000000', 'Test');
  cfg.sandbox.mode = 'ephemeral';
  cfg.sandbox.confine = false;

  const sandboxDir = join(paths.cache, 'sandboxes');
  await mkdir(join(sandboxDir, 'ses_live00000000'), { recursive: true });
  await mkdir(join(sandboxDir, 'ses_project00000'), { recursive: true });
  await mkdir(join(sandboxDir, 'ses_dead00000000'), { recursive: true });

  try {
    await createSandbox(cfg, paths, {
      listSessions: () => [{ id: 'ses_live00000000' }],
      listWorkplaceProjects: () => [{ id: 'ses_project00000' }]
    } as never);

    expect(existsSync(join(sandboxDir, 'ses_live00000000'))).toBe(true);
    expect(existsSync(join(sandboxDir, 'ses_project00000'))).toBe(true);
    expect(existsSync(join(sandboxDir, 'ses_dead00000000'))).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
