// Project high-dimensional vectors (e.g. mem0 embeddings) to 2D for a scatter/cluster view. Uses the
// N×N gram trick — cheap when there are few vectors but many dimensions (the mem0 case: tens of
// memories × ~1.5k dims) — and a couple of power-iteration steps for the top-2 components. Pure +
// deterministic (no RNG): the first two coordinate axes seed the iterations.

/** Returns one {x,y} per input vector, centered near the origin. Fewer than 2 vectors → all at origin. */
export function project2d(vectors: number[][]): { x: number; y: number }[] {
  const n = vectors.length;
  if (n === 0) return [];
  const d = vectors[0]?.length ?? 0;
  if (n < 2 || d === 0) return vectors.map(() => ({ x: 0, y: 0 }));

  // Center the columns.
  const mean = new Array<number>(d).fill(0);
  for (const v of vectors) for (let j = 0; j < d; j++) mean[j] = (mean[j] ?? 0) + (v[j] ?? 0) / n;
  const xc = vectors.map((v) => v.map((val, j) => val - (mean[j] ?? 0)));

  // Gram matrix G = Xc · Xcᵀ (n×n). Its top eigenvectors, scaled by √eigenvalue, ARE the PCA scores.
  const g: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    const gi = g[i] as number[];
    const a = xc[i] as number[];
    for (let k = i; k < n; k++) {
      let s = 0;
      const b = xc[k] as number[];
      for (let j = 0; j < d; j++) s += (a[j] ?? 0) * (b[j] ?? 0);
      gi[k] = s;
      (g[k] as number[])[i] = s;
    }
  }

  const comp1 = topEigen(g, seedAxis(n, 0), null);
  const comp2 = topEigen(g, seedAxis(n, 1), comp1.vec);
  const x = comp1.vec.map((u) => u * Math.sqrt(Math.max(0, comp1.val)));
  const y = comp2.vec.map((u) => u * Math.sqrt(Math.max(0, comp2.val)));
  return x.map((xi, i) => ({ x: xi, y: y[i] ?? 0 }));
}

/** Power iteration for the dominant eigenpair of a symmetric matrix, optionally deflating `against`. */
function topEigen(m: number[][], seed: number[], against: number[] | null): { vec: number[]; val: number } {
  let v = normalize(against ? orthogonalize(seed, against) : seed);
  let val = 0;
  for (let iter = 0; iter < 50; iter++) {
    let w = matVec(m, v);
    if (against) w = orthogonalize(w, against); // keep it in the complement of comp1
    const norm = Math.hypot(...w);
    if (norm < 1e-12) break;
    w = w.map((x) => x / norm);
    val = dot(w, matVec(m, w));
    if (dot(w, v) > 1 - 1e-9) {
      v = w;
      break;
    }
    v = w;
  }
  return { vec: v, val };
}

function seedAxis(n: number, axis: number): number[] {
  const s = new Array<number>(n).fill(1 / Math.sqrt(n));
  if (axis < n) s[axis] = (s[axis] ?? 0) + 0.5; // break symmetry so comp1/comp2 seeds differ
  return s;
}
const dot = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
const matVec = (m: number[][], v: number[]): number[] => m.map((row) => dot(row, v));
const normalize = (v: number[]): number[] => {
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
};
const orthogonalize = (v: number[], against: number[]): number[] => {
  const p = dot(v, against);
  return v.map((x, i) => x - p * (against[i] ?? 0));
};
