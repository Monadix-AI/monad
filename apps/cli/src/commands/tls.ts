import type { CommandDef } from './types.ts';

import { join } from 'node:path';
import { certExpiry, certFingerprint, ensureTlsCert, getPaths, renewTlsCert } from '@monad/environment';

import { t } from '../lib/i18n.ts';
import { bold, dim, green, json, out, red, yellow } from '../lib/output.ts';
import { CliError, EXIT } from './types.ts';

async function showCert(certPath: string): Promise<void> {
  const file = Bun.file(certPath);
  if (!(await file.exists())) {
    out(yellow(t('cli.tls.certNotFound')));
    return;
  }

  let fingerprint: string | undefined;
  let expiresStr: string | undefined;
  try {
    [fingerprint, expiresStr] = await Promise.all([certFingerprint(certPath), certExpiry(certPath)]);
  } catch {
    /* openssl unavailable */
  }

  const expiresIso = expiresStr != null ? new Date(expiresStr).toISOString() : null;
  json({ certPath, fingerprint: fingerprint ?? null, expires: expiresIso });

  out(dim(t('cli.tls.certPath', { path: certPath })));
  if (fingerprint) out(`  ${t('cli.tls.fingerprint', { fp: bold(fingerprint) })}`);
  if (expiresStr != null) {
    out(
      `  ${t('cli.tls.expires', { date: dim(new Date(expiresStr).toLocaleDateString(undefined, { dateStyle: 'long' })) })}`
    );
  } else {
    out(yellow(`  ${t('cli.tls.opensslUnavailable')}`));
  }
}

function loginKeychainPath(): string {
  return join(Bun.env.HOME ?? process.env.HOME ?? '', 'Library', 'Keychains', 'login.keychain-db');
}

async function trustCert(tlsDir: string): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new CliError(t('cli.tls.trustUnsupported'), EXIT.USAGE);
  }

  const cert = await ensureTlsCert(tlsDir);
  const keychain = loginKeychainPath();
  const result = Bun.spawnSync([
    'security',
    'add-trusted-cert',
    '-d',
    '-r',
    'trustRoot',
    '-p',
    'ssl',
    '-k',
    keychain,
    cert.certPath
  ]);
  if (result.exitCode !== 0) {
    const detail = new TextDecoder().decode(result.stderr).trim();
    throw new CliError(t('cli.tls.trustFailed', { msg: detail || `security exited ${result.exitCode}` }), EXIT.ERROR);
  }

  let fingerprint: string | undefined;
  try {
    fingerprint = await certFingerprint(cert.certPath);
  } catch {
    /* openssl unavailable */
  }

  json({
    action: 'trust',
    certPath: cert.certPath,
    fingerprint: fingerprint ?? null,
    keychain
  });

  out(`${green('✓')} ${t('cli.tls.trusted', { path: cert.certPath })}`);
  out(dim(t('cli.tls.trustedHint')));
}

export const command: CommandDef = {
  local: true,
  name: 'tls',
  synopsis: 'tls <subcommand>',
  description: 'manage the daemon TLS certificate',
  descriptionKey: 'cli.cmd.tls.desc',
  async run({ positionals }) {
    const [sub] = positionals;

    if (sub !== 'renew' && sub !== 'show' && sub !== 'trust') {
      out(`${bold(t('cli.tls.usageTitle'))} monad tls renew|show|trust`);
      out('');
      out(`  ${bold('renew')}  ${t('cli.tls.usageRenew')}`);
      out(`  ${bold('show ')}  ${t('cli.tls.usageShow')}`);
      out(`  ${bold('trust')}  ${t('cli.tls.usageTrust')}`);
      out(`         ${dim(t('cli.tls.usageRestartHint'))}`);
      return;
    }

    const paths = getPaths();
    const certPath = join(paths.tls, 'cert.pem');

    if (sub === 'show') {
      await showCert(certPath);
      return;
    }

    if (sub === 'trust') {
      await trustCert(paths.tls);
      return;
    }

    // renew
    out(dim(t('cli.tls.renewing')));

    let cert: { certPath: string; keyPath: string };
    try {
      cert = await renewTlsCert(paths.tls);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('openssl not found')) {
        throw new CliError(
          `${red('✖')} ${t('cli.tls.renewFailed', { msg })}\n  ${t('cli.tls.installOpenssl')}`,
          EXIT.ERROR
        );
      }
      throw new CliError(`${red('✖')} ${t('cli.tls.renewFailed', { msg })}`, EXIT.ERROR);
    }

    let fingerprint: string | undefined;
    let expiresStr: string | undefined;
    try {
      [fingerprint, expiresStr] = await Promise.all([certFingerprint(cert.certPath), certExpiry(cert.certPath)]);
    } catch {
      /* openssl unavailable — still report success */
    }

    const expiresIso = expiresStr != null ? new Date(expiresStr).toISOString() : null;
    json({
      certPath: cert.certPath,
      keyPath: cert.keyPath,
      fingerprint: fingerprint ?? null,
      expires: expiresIso
    });

    out(`${green('✓')} ${t('cli.tls.renewed', { path: cert.certPath })}`);
    if (fingerprint) out(`  ${t('cli.tls.fingerprint', { fp: bold(fingerprint) })}`);
    if (expiresStr != null) {
      out(
        `  ${t('cli.tls.expires', { date: dim(new Date(expiresStr).toLocaleDateString(undefined, { dateStyle: 'long' })) })}`
      );
    } else {
      out(yellow(`  ${t('cli.tls.opensslUnavailable')}`));
    }
    out('');
    out(dim(t('cli.tls.restartHint')));
    out(dim('  monad restart'));
  }
};
