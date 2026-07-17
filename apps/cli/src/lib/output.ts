// Output mode is resolved once from global flags + environment in main.ts (setOutputMode),
// then read by the color/print helpers below. Defaults are safe for direct imports (tests).
export type OutputFormat = 'human' | 'json' | 'yaml';

interface OutputMode {
  color: boolean;
  quiet: boolean;
  format: OutputFormat;
}

const mode: OutputMode = {
  color: !!process.stdout.isTTY && !Bun.env.NO_COLOR,
  quiet: false,
  format: 'human'
};

export const isStructured = (): boolean => mode.format !== 'human';
export const isHumanOutputEnabled = (): boolean => !mode.quiet && !isStructured();

/** Apply global flags. `--no-color`/`NO_COLOR`/non-TTY → no color; structured output disables color. */
export function setOutputMode(opts: { color?: boolean; quiet?: boolean; json?: boolean; format?: OutputFormat }): void {
  if (opts.format) mode.format = opts.format;
  if (opts.json) mode.format = 'json';
  if (opts.quiet) mode.quiet = true;
  const wantColor = opts.color ?? mode.color;
  mode.color = wantColor && !!process.stdout.isTTY && !Bun.env.NO_COLOR && !isStructured();
}

export const isJson = (): boolean => isStructured();
const _isQuiet = (): boolean => mode.quiet;

const c =
  (code: number) =>
  (s: string): string =>
    mode.color ? `\x1b[${code}m${s}\x1b[0m` : s;

const fg256 = (n: number) => (s: string) => (mode.color ? `\x1b[38;5;${n}m${s}\x1b[0m` : s);

export const bold = c(1);
export const dim = c(2);
export const red = c(31);
export const green = c(32);
export const yellow = c(33);
export const cyan = c(36);

/** Human-facing line on stdout. Suppressed under --quiet and structured output (json/yaml). */
export const out = (s: string): void => {
  if (mode.quiet || isStructured()) return;
  process.stdout.write(`${s}\n`);
};

/** Unconditional stdout line — for results that must print even under --quiet (still gated by structured). */
const _emit = (s: string): void => {
  if (isStructured()) return;
  process.stdout.write(`${s}\n`);
};

/** Machine-readable payload on stdout. No-op in human mode; emits JSON or YAML per the format. */
export const json = (value: unknown): void => {
  if (mode.format === 'json') process.stdout.write(`${JSON.stringify(value)}\n`);
  else if (mode.format === 'yaml') process.stdout.write(`${toYaml(value)}\n`);
};

/** Minimal YAML for the shapes the CLI emits: scalars, flat objects, and arrays of those. */
function toYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value.map((v) => `${pad}- ${toYaml(v, indent + 1).replace(/^\s+/, '')}`).join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return entries
      .map(([k, v]) => {
        const child = toYaml(v, indent + 1);
        return v && typeof v === 'object' ? `${pad}${k}:\n${child}` : `${pad}${k}: ${child}`;
      })
      .join('\n');
  }
  const s = String(value);
  return /[:#\n]/.test(s) ? JSON.stringify(s) : s;
}

/** Print `text`, routing through $PAGER when it's longer than the terminal on an interactive TTY.
 *  Suppressed under structured output (the caller emits via `json()` instead). */
export async function page(text: string): Promise<void> {
  if (isStructured()) return;
  const body = text.endsWith('\n') ? text : `${text}\n`;
  const rows = process.stdout.rows ?? 0;
  if (!process.stdout.isTTY || !rows || body.split('\n').length <= rows) {
    process.stdout.write(body);
    return;
  }
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: standard pager env var
  const [cmd, ...args] = (Bun.env.PAGER || 'less -FIRX').split(' ');
  try {
    const proc = Bun.spawn([cmd ?? 'less', ...args], { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' });
    proc.stdin.write(body);
    await proc.stdin.end();
    await proc.exited;
  } catch {
    process.stdout.write(body);
  }
}

export function printGoodbye(): void {
  if (!mode.color) return;

  const grad = [135, 105, 75, 39, 45, 51];
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
    // biome-ignore lint/style/noNonNullAssertion: loop bounded by lines.length
    process.stdout.write(`${bold(fg256(grad[i]!)(lines[i]!))}\n`);
  }
  process.stdout.write(`${rule}\n\n`);
}
