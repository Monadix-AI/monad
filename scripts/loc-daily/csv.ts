import type { LocRow, LocRowType } from './types.ts';

const CSV_HEADER = 'date,lines,files,type,note';

export function parseCsv(input: string): LocRow[] {
  const lines = input.trim().split(/\r?\n/);
  if (lines.length === 0 || lines[0] !== CSV_HEADER) return [];
  return lines
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const [date = '', rawLines = '0', rawFiles = '', type = 'actual', note = ''] = parseCsvLine(line);
      return {
        date,
        files: rawFiles ? Number(rawFiles) : undefined,
        lines: Number(rawLines),
        note,
        type: type as LocRowType
      };
    });
}

export function formatCsv(rows: LocRow[]): string {
  const body = rows
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .map((row) =>
      [row.date, String(row.lines), row.files == null ? '' : String(row.files), row.type, row.note]
        .map(escapeCsvCell)
        .join(',')
    )
    .join('\n');
  return `${CSV_HEADER}\n${body}${body ? '\n' : ''}`;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted && char === '"' && line[i + 1] === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function escapeCsvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}
