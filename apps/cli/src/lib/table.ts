import { bold } from './output.ts';

/** Render aligned, two-space-gutter columns. Cells must be plain (no ANSI) so widths are correct;
 *  the header row is bolded and body rows are truncated to the terminal width. Widths use
 *  Bun.stringWidth (not `.length`) so CJK and emoji cells — double-width in a terminal — stay
 *  aligned under translated output. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(Bun.stringWidth(h), ...rows.map((r) => Bun.stringWidth(r[i] ?? ''))));
  const max = process.stdout.columns ?? 0;
  const pad = (c: string, width: number): string => c + ' '.repeat(Math.max(0, width - Bun.stringWidth(c)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => pad(c ?? '', widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  const clip = (line: string): string => (max && Bun.stringWidth(line) > max ? `${line.slice(0, max - 1)}…` : line);
  return [bold(fmt(headers)), ...rows.map((r) => clip(fmt(r)))].join('\n');
}
