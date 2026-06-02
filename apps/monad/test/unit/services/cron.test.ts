import { expect, test } from 'bun:test';

import { CronError, nextCronTime, parseCron } from '@/services/scheduling/cron.ts';

test('parseCron expands steps, ranges, and lists', () => {
  expect([...parseCron('*/15 * * * *').minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  expect([...parseCron('1-3 * * * *').minute].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  expect([...parseCron('0 9,17 * * *').hour].sort((a, b) => a - b)).toEqual([9, 17]);
});

test('parseCron normalizes day-of-week 7 to Sunday and tracks restriction', () => {
  const f = parseCron('0 0 * * 7');
  expect(f.dow.has(0)).toBe(true);
  expect(f.dowRestricted).toBe(true);
  expect(parseCron('0 0 * * *').dowRestricted).toBe(false);
});

test('parseCron rejects malformed expressions', () => {
  expect(() => parseCron('* * * *')).toThrow(CronError); // 4 fields
  expect(() => parseCron('99 * * * *')).toThrow(CronError); // minute out of range
  expect(() => parseCron('* 25 * * *')).toThrow(CronError); // hour out of range
});

test('nextCronTime finds the next daily match', () => {
  const from = new Date(2026, 5, 14, 8, 0); // local 08:00
  const next = nextCronTime(parseCron('0 9 * * *'), from);
  expect(next).toEqual(new Date(2026, 5, 14, 9, 0));
});

test('nextCronTime rolls to the next day when today has passed', () => {
  const from = new Date(2026, 5, 14, 9, 30);
  expect(nextCronTime(parseCron('0 9 * * *'), from)).toEqual(new Date(2026, 5, 15, 9, 0));
});

test('nextCronTime honors a minute step', () => {
  const from = new Date(2026, 5, 14, 10, 7);
  expect(nextCronTime(parseCron('*/15 * * * *'), from)).toEqual(new Date(2026, 5, 14, 10, 15));
});

test('nextCronTime applies the Vixie OR rule when dom and dow are both restricted', () => {
  // "at 00:00 on the 13th OR on any Friday". 2026-06-14 is a Sunday; the 13th was Saturday.
  const from = new Date(2026, 5, 14, 12, 0);
  const next = nextCronTime(parseCron('0 0 13 * 5'), from);
  // Next match is Friday 2026-06-19 (a Friday), earlier than the 13th of next month.
  expect(next?.getDay()).toBe(5);
  expect(next).toEqual(new Date(2026, 5, 19, 0, 0));
});

test('nextCronTime strictly advances past the input minute', () => {
  const from = new Date(2026, 5, 14, 9, 0, 30); // already 09:00:30
  expect(nextCronTime(parseCron('0 9 * * *'), from)).toEqual(new Date(2026, 5, 15, 9, 0));
});
