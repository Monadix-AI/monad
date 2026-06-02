/**
 * Aggregates every `coverage/lcov.info` written by `MONAD_TEST_COVERAGE=1` into one
 * per-workspace table, prints it, and appends it to `$GITHUB_STEP_SUMMARY` when set.
 *
 * Deliberately has no third-party coverage service: the numbers are visible on the run
 * itself, so a fork PR sees the same output as a maintainer PR with no token.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

interface Totals {
  linesHit: number;
  linesFound: number;
}

const emptyTotals = (): Totals => ({ linesHit: 0, linesFound: 0 });

function parseLcov(text: string): Totals {
  const totals = emptyTotals();
  for (const line of text.split('\n')) {
    const [key, value] = line.split(':');
    const n = Number(value);
    if (Number.isNaN(n)) continue;
    if (key === 'LH') totals.linesHit += n;
    else if (key === 'LF') totals.linesFound += n;
  }
  return totals;
}

const pct = (hit: number, found: number) => (found === 0 ? '—' : `${((hit / found) * 100).toFixed(1)}%`);

async function findReports(): Promise<{ name: string; path: string }[]> {
  const found: { name: string; path: string }[] = [];
  // Bun resolves `coverageReporter` output against the bunfig root, so a workspace suite
  // run through Turbo still writes to the repo-root `coverage/`. Per-workspace paths are
  // checked too in case a package ever gains its own bunfig.
  try {
    await stat('coverage/lcov.info');
    found.push({ name: '(repo root)', path: 'coverage/lcov.info' });
  } catch {
    // No aggregate report this run.
  }
  for (const group of ['apps', 'packages']) {
    let entries: string[];
    try {
      entries = await readdir(group);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(group, entry, 'coverage', 'lcov.info');
      try {
        await stat(path);
        found.push({ name: `${group}/${entry}`, path });
      } catch {
        // Workspace produced no coverage this run.
      }
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

const reports = await findReports();
if (reports.length === 0) {
  process.stdout.write('No lcov.info found — was MONAD_TEST_COVERAGE=1 set?\n');
  process.exit(0);
}

const overall = emptyTotals();
const rows: string[] = [];
for (const { name, path } of reports) {
  const totals = parseLcov(await readFile(path, 'utf8'));
  overall.linesHit += totals.linesHit;
  overall.linesFound += totals.linesFound;
  rows.push(`| ${name} | ${pct(totals.linesHit, totals.linesFound)} | ${totals.linesHit}/${totals.linesFound} |`);
}

const summary = [
  `## Coverage — ${pct(overall.linesHit, overall.linesFound)} of lines`,
  '',
  '| Report | Lines | Covered/Total |',
  '| --- | --- | --- |',
  ...rows,
  '',
  `Totals: ${overall.linesHit}/${overall.linesFound} lines across ${reports.length} report(s). Bun emits no branch data.`,
  ''
].join('\n');

process.stdout.write(`${summary}\n`);

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) await Bun.write(summaryFile, `${await Bun.file(summaryFile).text()}${summary}`);
