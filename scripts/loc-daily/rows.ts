import type { LocRow, Snapshot } from './types.ts';

import { daysBetween } from './dates.ts';

const ESTIMATE_NOTE = 'log-linear backward extrapolation from first two midnight snapshots';
const MIDNIGHT_NOTE_PREFIX = 'midnight snapshot';

export function buildRows(dates: string[], snapshots: Map<string, Snapshot>): LocRow[] {
  const actualDates = dates.filter((date) => snapshots.has(date));
  const firstActual = actualDates[0];
  const secondActual = actualDates[1];
  return dates.map((date) => {
    const snapshot = snapshots.get(date);
    if (!snapshot) return estimateRow(date, firstActual, secondActual, snapshots);
    return {
      date,
      files: snapshot.files,
      lines: snapshot.lines,
      note: `${MIDNIGHT_NOTE_PREFIX} ${snapshot.commit}`,
      type: 'actual'
    };
  });
}

export function mergeRows(existingRows: LocRow[], newRows: LocRow[]): LocRow[] {
  const byDate = new Map(existingRows.map((row) => [row.date, row]));
  for (const row of newRows) byDate.set(row.date, row);
  return [...byDate.values()].toSorted((a, b) => a.date.localeCompare(b.date));
}

function estimateRow(
  date: string,
  firstActual: string | undefined,
  secondActual: string | undefined,
  snapshots: Map<string, Snapshot>
): LocRow {
  const first = firstActual ? snapshots.get(firstActual) : undefined;
  if (!first) return { date, files: undefined, lines: 0, note: 'no midnight snapshot available', type: 'estimated' };
  const second = secondActual ? snapshots.get(secondActual) : undefined;
  const daysBefore = daysBetween(date, firstActual);
  if (!second || daysBefore <= 0) {
    return {
      date,
      files: first.files,
      lines: first.lines,
      note: 'flat estimate from first midnight snapshot',
      type: 'estimated'
    };
  }
  const span = Math.max(1, daysBetween(firstActual, secondActual));
  const lineRatio = Math.max(0.0001, second.lines / Math.max(1, first.lines));
  const fileRatio = Math.max(0.0001, second.files / Math.max(1, first.files));
  return {
    date,
    files: Math.max(1, Math.round(first.files / fileRatio ** (daysBefore / span))),
    lines: Math.max(1, Math.round(first.lines / lineRatio ** (daysBefore / span))),
    note: ESTIMATE_NOTE,
    type: 'estimated'
  };
}
