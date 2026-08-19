import { cn } from '../lib/utils.ts';

interface AnsiState {
  color?: string;
  bold: boolean;
  dim: boolean;
}

export interface AnsiSegment {
  key: string;
  text: string;
  className?: string;
}

type AnsiPalette = 'adaptive' | 'dark';

const DARK_ANSI_COLOR_CLASSES: Record<number, string> = {
  30: 'text-zinc-300',
  31: 'text-red-300',
  32: 'text-emerald-300',
  33: 'text-yellow-300',
  34: 'text-info',
  35: 'text-fuchsia-300',
  36: 'text-cyan-300',
  37: 'text-zinc-100',
  90: 'text-zinc-500',
  91: 'text-red-200',
  92: 'text-emerald-200',
  93: 'text-yellow-200',
  94: 'text-info',
  95: 'text-fuchsia-200',
  96: 'text-cyan-200',
  97: 'text-foreground'
};

const ADAPTIVE_ANSI_COLOR_CLASSES: Record<number, string> = {
  30: 'text-zinc-900 dark:text-zinc-300',
  31: 'text-red-700 dark:text-red-300',
  32: 'text-emerald-700 dark:text-emerald-300',
  33: 'text-amber-700 dark:text-yellow-300',
  34: 'text-blue-700 dark:text-blue-300',
  35: 'text-fuchsia-700 dark:text-fuchsia-300',
  36: 'text-cyan-700 dark:text-cyan-300',
  37: 'text-zinc-600 dark:text-zinc-100',
  90: 'text-zinc-500',
  91: 'text-red-600 dark:text-red-200',
  92: 'text-emerald-600 dark:text-emerald-200',
  93: 'text-amber-600 dark:text-yellow-200',
  94: 'text-blue-600 dark:text-blue-200',
  95: 'text-fuchsia-600 dark:text-fuchsia-200',
  96: 'text-cyan-600 dark:text-cyan-200',
  97: 'text-foreground'
};

const ANSI_SGR_PATTERN_SOURCE = `${String.fromCharCode(27)}\\[([0-9;]*)m`;

export function hasAnsiSgr(text: string): boolean {
  return new RegExp(ANSI_SGR_PATTERN_SOURCE).test(text);
}

export function parseAnsiText(text: string, baseClassName?: string, palette: AnsiPalette = 'dark'): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  const state: AnsiState = { bold: false, dim: false };
  const pattern = new RegExp(ANSI_SGR_PATTERN_SOURCE, 'g');
  const colorClasses = palette === 'adaptive' ? ADAPTIVE_ANSI_COLOR_CLASSES : DARK_ANSI_COLOR_CLASSES;
  let cursor = 0;
  let match: RegExpExecArray | null;

  const className = () => cn(baseClassName, state.color, state.bold && 'font-semibold', state.dim && 'opacity-70');
  const pushText = (value: string, start: number) => {
    if (value)
      segments.push({ key: `${start}-${value.length}-${segments.length}`, text: value, className: className() });
  };

  for (;;) {
    match = pattern.exec(text);
    if (!match) break;
    pushText(text.slice(cursor, match.index), cursor);
    cursor = pattern.lastIndex;
    const codes = match[1] ? match[1].split(';').map((code) => Number.parseInt(code, 10)) : [0];
    for (const code of codes) {
      if (!Number.isFinite(code) || code === 0) {
        state.color = undefined;
        state.bold = false;
        state.dim = false;
      } else if (code === 1) {
        state.bold = true;
      } else if (code === 2) {
        state.dim = true;
      } else if (code === 22) {
        state.bold = false;
        state.dim = false;
      } else if (code === 39) {
        state.color = undefined;
      } else if (colorClasses[code]) {
        state.color = colorClasses[code];
      }
    }
  }

  pushText(text.slice(cursor), cursor);
  return segments;
}

export function AnsiText({ segments }: { segments: AnsiSegment[] }): React.ReactElement {
  return (
    <>
      {segments.map((segment) => (
        <span
          className={segment.className}
          key={segment.key}
        >
          {segment.text}
        </span>
      ))}
    </>
  );
}
