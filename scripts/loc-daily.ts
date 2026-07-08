#!/usr/bin/env bun
import type { LocRow } from './loc-daily/types.ts';

import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { collectSnapshots } from './loc-daily/count.ts';
import { formatCsv, parseCsv } from './loc-daily/csv.ts';
import { dateRange, formatDate } from './loc-daily/dates.ts';
import { writeHtml } from './loc-daily/report.ts';
import { buildRows, mergeRows } from './loc-daily/rows.ts';

interface CliOptions {
  csvPath: string;
  from?: string;
  htmlPath: string;
  rebuild: boolean;
  renderHtml: boolean;
  to: string;
}

const ROOT = resolve(import.meta.dir, '..');
const DEFAULT_CSV = join(ROOT, 'scripts', 'monad_loc_by_day.csv');
const DEFAULT_HTML = join(ROOT, 'scripts', 'monad_loc_report.html');

async function main() {
  const options = parseArgs(Bun.argv.slice(2));
  const existingRows = await readExistingRows(options.csvPath);
  const allDates = await resolveTargetDates(options, existingRows);
  const existingDates = new Set(existingRows.map((row) => row.date));
  const datesToWrite = options.rebuild ? allDates : allDates.filter((date) => !existingDates.has(date));
  if (datesToWrite.length === 0) {
    if (options.renderHtml) await writeHtml(options.htmlPath, existingRows);
    return;
  }

  const snapshots = await collectSnapshots(ROOT, allDates);
  const computedRows = buildRows(allDates, snapshots);
  const rows = options.rebuild
    ? computedRows
    : mergeRows(
        existingRows,
        computedRows.filter((row) => !existingDates.has(row.date))
      );
  await mkdir(dirname(options.csvPath), { recursive: true });
  await Bun.write(options.csvPath, formatCsv(rows));
  if (options.renderHtml) await writeHtml(options.htmlPath, rows);

  const mode = options.rebuild ? 'rebuilt' : 'updated';
  process.stdout.write(`${mode} ${options.csvPath}\n`);
  if (options.renderHtml) process.stdout.write(`rendered ${options.htmlPath}\n`);
}

async function readExistingRows(csvPath: string): Promise<LocRow[]> {
  try {
    return parseCsv(await Bun.file(csvPath).text());
  } catch {
    return [];
  }
}

async function resolveTargetDates(options: CliOptions, existingRows: LocRow[]): Promise<string[]> {
  const from = await resolveStartDate(options, existingRows);
  return dateRange(from, options.to);
}

async function resolveStartDate(options: CliOptions, existingRows: LocRow[]): Promise<string> {
  if (options.from) return options.from;
  if (options.rebuild) return existingRows[0]?.date ?? '2026-06-02';
  return existingRows[0]?.date ?? (await firstCommitDate());
}

async function firstCommitDate(): Promise<string> {
  const iso = await Bun.$`git log --all --reverse --pretty=%cI --max-count=1`.cwd(ROOT).text();
  return formatDate(new Date(iso.trim()));
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    csvPath: DEFAULT_CSV,
    htmlPath: DEFAULT_HTML,
    rebuild: false,
    renderHtml: true,
    to: formatDate(new Date())
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--rebuild') options.rebuild = true;
    else if (arg === '--no-html') options.renderHtml = false;
    else if (arg === '--csv') options.csvPath = resolve(args[++i]);
    else if (arg === '--html') options.htmlPath = resolve(args[++i]);
    else if (arg === '--from') options.from = args[++i];
    else if (arg === '--to') options.to = args[++i];
    else if (arg === '--help') {
      printHelp();
      process.exit(0);
    }
  }
  return options;
}

function printHelp() {}

if (import.meta.main) {
  await main();
}
