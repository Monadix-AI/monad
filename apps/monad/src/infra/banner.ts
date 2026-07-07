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

export function formatWebUiReadyValue(opts: { webUrl: string; daemonUrl?: string }): string {
  if (!opts.daemonUrl || opts.webUrl.replace(/\/$/, '') === opts.daemonUrl.replace(/\/$/, '')) return opts.webUrl;
  return `${opts.webUrl}  (Daemon API: ${opts.daemonUrl})`;
}

export function formatReadyPath(path: string, homeDir = Bun.env.HOME): string {
  if (!homeDir) return path;
  const normalizedHome = homeDir.replace(/\/+$/, '');
  if (path === normalizedHome) return '~';
  return path.startsWith(`${normalizedHome}/`) ? `~/${path.slice(normalizedHome.length + 1)}` : path;
}

function wrapReadyValue(value: string, width: number): string[] {
  const lines: string[] = [];
  let remaining = value;
  const safeWidth = Math.max(24, width);

  while (remaining.length > safeWidth) {
    const slice = remaining.slice(0, safeWidth + 1);
    const spaceBreak = slice.lastIndexOf(' ');
    const slashBreak = slice.lastIndexOf('/');
    const usefulBreakFloor = Math.floor(safeWidth * 0.45);
    const cut = spaceBreak > usefulBreakFloor ? spaceBreak : slashBreak > usefulBreakFloor ? slashBreak + 1 : safeWidth;
    lines.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  lines.push(remaining);
  return lines;
}

export function formatReadyInfoTable(rows: Array<[string, string]>, columns = process.stdout.columns ?? 100): string {
  const labelCol = Math.max(...rows.map(([label]) => label.length)) + 2;
  const indent = '  ';
  const gap = '  ';
  const valueWidth = Math.max(24, columns - indent.length - labelCol - gap.length);
  const continuation = `${indent}${' '.repeat(labelCol)}${gap}`;

  return rows
    .flatMap(([label, value]) => {
      const valueLines = wrapReadyValue(value, valueWidth);
      return valueLines.map((line, index) =>
        index === 0 ? `${indent}${bold(label.padEnd(labelCol))}${gap}${line}` : `${continuation}${line}`
      );
    })
    .join('\n');
}

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
  daemonUrl?: string;
  docsUrl?: string;
  unixSocket?: string;
  tlsFingerprint?: string;
  configPath: string;
  t: DaemonTranslate;
}): void {
  if (!bannerVisible()) return;

  const { t, webUrl, daemonUrl, docsUrl, unixSocket, tlsFingerprint, configPath } = opts;
  const rows: Array<[string, string]> = [[t('daemon.ready.webUi'), formatWebUiReadyValue({ webUrl, daemonUrl })]];
  if (docsUrl) rows.push(['API docs:', docsUrl]);
  if (unixSocket) rows.push(['Unix socket:', formatReadyPath(unixSocket)]);
  if (tlsFingerprint) rows.push(['TLS:', `SHA-256 ${tlsFingerprint}`]);
  rows.push([t('daemon.ready.cli'), 'monad --help'], [t('daemon.ready.configure'), formatReadyPath(configPath)]);

  process.stdout.write(`${bold(green(t('daemon.ready.title')))}\n\n`);
  process.stdout.write(`${formatReadyInfoTable(rows)}\n\n`);
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
