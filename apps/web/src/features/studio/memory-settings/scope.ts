// Shared scope helpers for the Memory panel's data views (facts / graph / laws / mem0). Memory is
// scoped by `global`, `agent:<id>`, or `project:<key>`; these keep the label short and color it
// stably across views.

const PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#ec4899', '#14b8a6'];

/** Drop the `<kind>:` prefix: `agent:undefined…` → `undefined…`, `project:repo-ab12cd` → `repo-ab12cd`;
 *  `global` (no prefix) stays as-is. */
export function scopeLabel(scope: string): string {
  const i = scope.indexOf(':');
  return i === -1 ? scope : scope.slice(i + 1);
}

/** Stable color for a scope (or any key) — same key always lands in the same palette bucket. */
export function colorForScope(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length] as string;
}
