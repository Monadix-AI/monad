// project2d: deterministic 2D projection for the mem0 cluster view.

import { expect, test } from 'bun:test';

import { project2d } from '@/services/memory/pca2d.ts';

test('degenerate inputs are safe', () => {
  expect(project2d([[1, 2, 3]])).toEqual([{ x: 0, y: 0 }]); // <2 vectors → origin
});

test('separates two high-dimensional clusters along the principal axis', () => {
  // Two tight clusters far apart in 6-D; PC1 should split them, so the x-gap between cluster means
  // dwarfs the within-cluster spread.
  const A = [
    [10, 10, 0, 0, 0, 0],
    [11, 9, 0, 1, 0, 0],
    [9, 11, 1, 0, 0, 0]
  ];
  const B = [
    [-10, -10, 0, 0, 0, 0],
    [-9, -11, 0, 1, 0, 0],
    [-11, -9, 1, 0, 0, 0]
  ];
  const pts = project2d([...A, ...B]);
  expect(pts).toHaveLength(6);
  const meanX = (s: number, e: number) => pts.slice(s, e).reduce((a, p) => a + p.x, 0) / (e - s);
  const spread = (s: number, e: number) => {
    const m = meanX(s, e);
    return Math.max(...pts.slice(s, e).map((p) => Math.abs(p.x - m)));
  };
  const gap = Math.abs(meanX(0, 3) - meanX(3, 6));
  expect(gap).toBeGreaterThan(spread(0, 3) * 4); // clusters clearly separated on PC1
  expect(gap).toBeGreaterThan(spread(3, 6) * 4);
});

test('produces one point per vector and finite coordinates', () => {
  const vecs = Array.from({ length: 12 }, (_, i) => [Math.sin(i), Math.cos(i), i % 3, (i * 7) % 5]);
  const pts = project2d(vecs);
  expect(pts).toHaveLength(12);
  for (const p of pts) {
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  }
});
