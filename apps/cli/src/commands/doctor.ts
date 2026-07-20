import type { CommandDef } from './types.ts';

import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { certExpiry, certFingerprint, getPaths, loadConfig, resolveClientConn } from '@monad/environment';
import { getHealthResponseSchema, MONAD_VERSION } from '@monad/protocol';

import { dim, green, json, out, red, yellow } from '../lib/output.ts';
import { CliError, EXIT } from './types.ts';

interface Check {
  name: string;
  ok: boolean;
  warn?: boolean; // a soft failure: reported but does not change the exit code
  detail: string;
}

// Diagnose a monad install: config validity, daemon reachability, version skew, data-dir
// writability, and socket permissions. Exits non-zero on a hard failure, so it doubles as a
// scriptable health gate (`monad doctor && …`). Soft issues are flagged but don't fail the gate.
export const command: CommandDef = {
  name: 'doctor',
  synopsis: 'doctor',
  description: 'diagnose configuration, connection, and version problems',
  descriptionKey: 'cli.cmd.doctor.desc',
  async run({ client }) {
    const paths = getPaths();
    const checks: Check[] = [];

    // config.json present and valid.
    let transport: string | undefined;
    try {
      const cfg = await loadConfig(paths);
      if (cfg) {
        transport = cfg.network.transport;
        checks.push({ name: 'config', ok: true, detail: paths.config });
      } else {
        checks.push({ name: 'config', ok: false, detail: `missing — run \`monad init\` (${paths.config})` });
      }
    } catch (err) {
      checks.push({
        name: 'config',
        ok: false,
        detail: (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? 'invalid'
      });
    }

    // daemon reachable (+ capture its version for the skew check).
    const { baseUrl } = await resolveClientConn();
    let daemonVersion: string | undefined;
    let healthData: { version?: string; latestVersion?: string } | null = null;
    try {
      const { data } = await client.treaty.health.get();
      healthData = data === null ? null : getHealthResponseSchema.parse(data);
      daemonVersion = healthData?.version;
    } catch {
      /* unreachable */
    }
    const daemonOk = daemonVersion !== undefined;
    checks.push({
      name: 'daemon',
      ok: daemonOk,
      detail: daemonOk ? baseUrl : `unreachable at ${baseUrl} — run \`monad start\``
    });

    // version skew between this client and the running daemon (soft — restart or upgrade resolves it).
    if (daemonOk && daemonVersion !== MONAD_VERSION) {
      checks.push({
        name: 'version',
        ok: false,
        warn: true,
        detail: `client ${MONAD_VERSION} ≠ daemon ${daemonVersion} — run \`monad upgrade\` then restart`
      });
    } else {
      checks.push({ name: 'version', ok: true, detail: MONAD_VERSION });
    }

    // upstream version check (surfaced by daemon background poller, best-effort).
    const latestVersion = healthData?.latestVersion;
    if (daemonOk && latestVersion && latestVersion !== daemonVersion) {
      checks.push({
        name: 'upgrade',
        ok: false,
        warn: true,
        detail: `new version available: ${latestVersion} (run \`monad upgrade\`)`
      });
    }

    // data directory is writable.
    try {
      const probe = join(paths.home, '.doctor-probe');
      await Bun.write(probe, 'ok');
      await rm(probe, { force: true });
      checks.push({ name: 'disk', ok: true, detail: `writable: ${paths.home}` });
    } catch {
      checks.push({ name: 'disk', ok: false, detail: `not writable: ${paths.home}` });
    }

    // socket permissions (unix + uds transport): the socket must not be world-accessible.
    if (process.platform !== 'win32' && transport === 'uds') {
      try {
        const mode = (await stat(paths.sock)).mode & 0o077;
        checks.push({
          name: 'socket',
          ok: mode === 0,
          warn: mode !== 0,
          detail: mode === 0 ? `0600 ${paths.sock}` : `group/other-accessible (${paths.sock})`
        });
      } catch {
        /* no socket yet (daemon down or tcp) — nothing to check */
      }
    }

    // TLS certificate validity (only when the cert file exists).
    try {
      const certPath = join(paths.tls, 'cert.pem');
      await stat(certPath);
      try {
        const [expiry, fp] = await Promise.all([certExpiry(certPath), certFingerprint(certPath)]);
        const daysLeft = Math.floor((new Date(expiry).getTime() - Date.now()) / 86_400_000);
        if (daysLeft < 0) {
          checks.push({
            name: 'tls',
            ok: false,
            detail: `certificate expired ${-daysLeft}d ago (${fp.slice(0, 16)}…)`
          });
        } else if (daysLeft < 30) {
          checks.push({
            name: 'tls',
            ok: false,
            warn: true,
            detail: `certificate expires in ${daysLeft}d — run \`monad tls renew\``
          });
        } else {
          checks.push({ name: 'tls', ok: true, detail: `valid ${daysLeft}d  ${fp.slice(0, 16)}…` });
        }
      } catch {
        checks.push({ name: 'tls', ok: false, warn: true, detail: 'could not read cert (openssl unavailable?)' });
      }
    } catch {
      /* no TLS cert — skip; only present when remote access is enabled */
    }

    const hardFail = checks.some((c) => !c.ok && !c.warn);
    json({ ok: !hardFail, checks });

    for (const c of checks) {
      const mark = c.ok ? green('✓') : c.warn ? yellow('!') : red('✖');
      out(`${mark} ${c.name.padEnd(8)} ${dim(c.detail)}`);
    }
    if (hardFail) {
      const failed = checks
        .filter((c) => !c.ok && !c.warn)
        .map((c) => c.name)
        .join(', ');
      out(yellow(`✖ ${failed} check${failed.includes(',') ? 's' : ''} failed`));
      throw new CliError('', EXIT.CONFIG);
    }
    out(green('✓ all checks passed'));
  }
};
