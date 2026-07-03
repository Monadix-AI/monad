import type { CommandDef } from './types.ts';

import { enableRemoteAccess, getLanIp, getPaths, getTailscaleIp, loadConfig } from '@monad/home';

import { t } from '../lib/i18n.ts';
import { bold, cyan, dim, green, out, red, yellow } from '../lib/output.ts';

// qrcode-terminal has no @types package; the API is stable and narrow.
const qr = require('qrcode-terminal') as {
  generate: (text: string, opts: { small?: boolean }, cb: (qr: string) => void) => void;
};

const MODES = ['lan', 'overlay'] as const;
type Mode = (typeof MODES)[number];

/**
 * Generate or rotate a remote-access token and print a QR code for LAN pairing.
 * The daemon must be restarted to bind 0.0.0.0 after enabling remote access.
 */
export const command: CommandDef = {
  local: true,
  name: 'pair',
  synopsis: 'pair',
  description: 'enable remote access and print a QR code for mobile pairing',
  flags: {
    rotate: { type: 'boolean', description: 'force a new token even if one already exists' },
    'show-token': { type: 'boolean', description: 'print the full token instead of masking it' },
    mode: { type: 'string', description: 'address mode: lan (default) or overlay (Tailscale)' }
  },
  async run(ctx) {
    const rotate = Boolean(ctx.flags.rotate);
    const showToken = Boolean(ctx.flags['show-token']);
    const mode = (ctx.flags.mode as Mode | undefined) ?? 'lan';

    if (!MODES.includes(mode)) {
      out(`${red('✖')} invalid --mode ${bold(mode)} — expected ${bold('lan')} or ${bold('overlay')}`);
      process.exit(1);
    }

    const paths = getPaths();
    const cfg = await loadConfig(paths.config);
    if (!cfg) {
      out(`${red('✖')} no config yet — run ${bold('monad init')} first`);
      process.exit(1);
    }

    const { token, changed } = await enableRemoteAccess(paths.config, { rotate });
    const port = cfg.network.port;

    const ip = mode === 'overlay' ? getTailscaleIp() : getLanIp();
    if (!ip) {
      out(
        mode === 'overlay'
          ? `${yellow('⚠')} no Tailscale address found — is Tailscale running and logged in?`
          : `${yellow('⚠')} no LAN IPv4 found — are you on a network?`
      );
    }

    const baseUrl = ip ? `http://${ip}:${port}` : null;
    const masked = showToken ? token : `${token.slice(0, 6)}…${dim(t('cli.pair.showTokenHint'))}`;

    out('');
    out(`${green('●')} ${changed ? t('cli.pair.enabled') : t('cli.pair.alreadyActive')}`);
    out('');
    out(`  ${bold(t('cli.pair.urlLabel'))}   ${baseUrl ? cyan(baseUrl) : red(t('cli.pair.addressUnavailable'))}`);
    out(`  ${bold(t('cli.pair.tokenLabel'))} ${masked}`);
    out('');

    if (baseUrl) {
      const payload = JSON.stringify({ url: baseUrl, token });
      out(dim(t('cli.pair.scanHint')));
      out('');
      qr.generate(payload, { small: true }, (qrStr: string) => {
        for (const line of qrStr.split('\n')) out(`  ${line}`);
      });
      out('');
      out(dim(t('cli.pair.rotateHint')));
    }

    out(`${yellow('!')} ${t('cli.pair.restartApply', { cmd: bold('monad restart') })}`);
    out(dim(t('cli.pair.restartReason')));
    out('');
  }
};
