export function nextDate(date: string): string {
  const [year, month, day] = parseDateParts(date);
  return formatDate(new Date(year, month - 1, day + 1));
}

export function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = nextDate(date)) dates.push(date);
  return dates;
}

export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function midnightIso(date: string): string {
  const [year, month, day] = parseDateParts(date);
  return new Date(year, month - 1, day, 0, 0, 0, 0).toISOString();
}

export function daysBetween(start: string, end: string): number {
  return Math.round((dateValue(end).getTime() - dateValue(start).getTime()) / 86_400_000);
}

function dateValue(date: string): Date {
  const [year, month, day] = parseDateParts(date);
  return new Date(year, month - 1, day);
}

function parseDateParts(date: string): [number, number, number] {
  const parts = date.split('-').map(Number);
  if (parts.length !== 3 || parts.some((value) => Number.isNaN(value))) {
    throw new Error(`invalid date: ${date}`);
  }
  return [parts[0] as number, parts[1] as number, parts[2] as number];
}
