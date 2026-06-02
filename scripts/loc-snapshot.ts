#!/usr/bin/env bun

import { join, resolve } from 'node:path';

interface SccLanguage {
  Count: number;
  Lines: number;
}

const root = resolve(import.meta.dir, '..');
const historyPath = join(root, 'docs', 'metrics', 'loc-history.csv');
const date = new Intl.DateTimeFormat('en-CA', {
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(new Date());
const history = (await Bun.file(historyPath).text()).trimEnd();

const result = await Bun.$`scc --include-ext ts,tsx --format json ${root}`.json();
const languages = Array.isArray(result) ? result.filter(isSccLanguage) : [];
const totals = languages.reduce(
  (sum, language) => ({
    files: sum.files + language.Count,
    lines: sum.lines + language.Lines
  }),
  { files: 0, lines: 0 }
);

if (totals.files === 0 || totals.lines === 0) throw new Error('scc returned no TypeScript files');

const row = `${date},${totals.lines},${totals.files}`;
const rows = history.split('\n');
const existingIndex = rows.findIndex((entry) => entry.startsWith(`${date},`));
const action = existingIndex === -1 ? 'appended' : 'updated';
if (existingIndex === -1) rows.push(row);
else rows[existingIndex] = row;

await Bun.write(historyPath, `${rows.join('\n')}\n`);
process.stdout.write(`[metrics:loc] ${action} ${date}: ${totals.lines} lines across ${totals.files} files\n`);

function isSccLanguage(value: unknown): value is SccLanguage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'Count' in value &&
    typeof value.Count === 'number' &&
    'Lines' in value &&
    typeof value.Lines === 'number'
  );
}
