import type { StrictTranslateForNamespace } from '@monad/i18n';

type DaemonTranslate = StrictTranslateForNamespace<'daemon'>;

const useColor = !Bun.env.NO_COLOR;
const fg = (n: number) => (s: string) => (useColor ? `\x1b[38;5;${n}m${s}\x1b[0m` : s);
const bold = (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
const green = (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s);
const startupGrad = [51, 45, 39, 75, 105, 135];
const goodbyeGrad = [...startupGrad].reverse();

function gradientColor(grad: number[], index: number, total: number): number {
  const last = grad.length - 1;
  if (total <= 1) return grad[0] ?? 15;
  return grad[Math.round((index / (total - 1)) * last)] ?? 15;
}

// Show the banner/ready-info when attached to a terminal, or when `monad start` launched us
// detached with --start-relay so it can relay our stdout back to the user until we're reachable.
const bannerVisible = (): boolean => !!process.stdout.isTTY || process.argv.includes('--start-relay');

export function printBanner(version: string, mock: boolean): void {
  if (!bannerVisible() || Bun.env.NO_COLOR) return;

  const lines = [
    '        ▄▄▄▄▄',
    '    ▄▄█▀▀▀▀▀▀▀█▄▄                                              ██',
    '   ██▀         ▀██                                            ▄█▀',
    '  █▀ ▄▄▄▄▄▄▄▄▄▄▄ ██    ▄█████▄   ▄█▄████▄   ▄█████▄██  ▄▄████▄██',
    ' ██  ▀██▀ ██▀ ██  █  ▄█▀    ▀██  ██▀   ██  ██▀    ██  ██▀   ▀██',
    ' ██  ██  ▄█▀ ▄█▀  █▀ ██      ██ ██     █▀ ██      █▀ ██      █▀',
    ' ██ ▄█   █▀  █▀  ▄█  ██     ▄█▀▄█▀    ██  ██     ██  ██     ██',
    '  █▄█▀  █▀   █▄▄█▀   ▀█▄▄▄▄██▀ ██     █▄▄ ▀█▄▄▄▄███▄ ▀█▄▄▄▄██▄▄',
    '   █▄         ▀▀▄▄     ▀▀▀▀    ▀      ▀▀▀   ▀▀▀▀ ▀▀▀   ▀▀▀  ▀▀▀',
    '    ▀▀█▄▄▄▄▄▄▄██▀',
    '       ▀▀▀▀▀▀▀'
  ];

  const width = Math.max(...lines.map((line) => line.length));
  const mockLabel = mock ? dim('  mock') : '';
  const versionLine = bold(fg(startupGrad[2] ?? 39)(`  v${version}`)) + mockLabel;
  const rule = dim('─'.repeat(width));

  process.stdout.write('\n');
  for (let i = 0; i < lines.length; i++) {
    process.stdout.write(`${bold(fg(gradientColor(startupGrad, i, lines.length))(lines[i] ?? ''))}\n`);
  }
  process.stdout.write(`${versionLine}\n`);
  process.stdout.write(`${rule}\n\n`);
}

/** The success/environment summary printed once the daemon is listening — the single source of
 *  truth for "where's the UI, where's my config" shown by `monad start`, `monad daemon`, and the
 *  installer alike. */
export function printReadyInfo(opts: {
  webUrl: string;
  configPath: string;
  guidePath: string;
  t: DaemonTranslate;
}): void {
  if (!bannerVisible()) return;

  const { t, webUrl, configPath, guidePath } = opts;
  const rows: Array<[string, string]> = [
    [t('daemon.ready.webUi'), webUrl],
    [t('daemon.ready.cli'), 'monad --help'],
    [t('daemon.ready.configure'), configPath],
    [t('daemon.ready.guide'), guidePath]
  ];
  const col = Math.max(...rows.map(([label]) => label.length)) + 2;

  process.stdout.write(`${bold(green(t('daemon.ready.title')))}\n\n`);
  for (const [label, value] of rows) {
    process.stdout.write(`  ${bold(label.padEnd(col))}${value}\n`);
  }
  process.stdout.write('\n');
}

export function printGoodbye(): void {
  if (!process.stdout.isTTY || Bun.env.NO_COLOR) return;

  const lines = [
    ' ██████╗   ██████╗   ██████╗  ██████╗  ██████╗  ██╗   ██╗ ███████╗',
    '██╔════╝  ██╔═══██╗ ██╔═══██╗ ██╔══██╗ ██╔══██╗ ╚██╗ ██╔╝ ██╔════╝',
    '██║  ███╗ ██║   ██║ ██║   ██║ ██║  ██║ ██████╔╝  ╚████╔╝  █████╗  ',
    '██║   ██║ ██║   ██║ ██║   ██║ ██║  ██║ ██╔══██╗   ╚██╔╝   ██╔══╝  ',
    '╚██████╔╝ ╚██████╔╝ ╚██████╔╝ ██████╔╝ ██████╔╝    ██║    ███████╗',
    ' ╚═════╝   ╚═════╝   ╚═════╝  ╚═════╝  ╚═════╝     ╚═╝    ╚══════╝'
  ];

  const width = lines[0]?.length ?? 0;
  const rule = dim('─'.repeat(width));

  process.stdout.write('\n');
  for (let i = 0; i < lines.length; i++) {
    process.stdout.write(`${bold(fg(gradientColor(goodbyeGrad, i, lines.length))(lines[i] ?? ''))}\n`);
  }
  process.stdout.write(`${rule}\n\n`);
}
