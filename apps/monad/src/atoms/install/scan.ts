// Best-effort static scan of an atom bundle. Advisory only — surfaced to the user for the
// consent decision, NOT a security boundary (a determined bundle can obfuscate). In-process JS
// can't actually be sandboxed; real enforcement needs the out-of-process adapter host (later).

const PATTERNS: { re: RegExp; msg: string }[] = [
  { re: /\beval\s*\(/, msg: 'uses eval()' },
  { re: /\bnew\s+Function\s*\(/, msg: 'uses the Function constructor' },
  { re: /child_process|node:child_process|Bun\.spawn|Bun\.\$/, msg: 'spawns subprocesses' },
  { re: /\bnode:fs\b|\bfrom\s+['"]fs['"]/, msg: 'accesses the filesystem directly' },
  { re: /Bun\.env\b/, msg: 'reads Bun.env (may exfiltrate secrets)' }
];

/** Return human-readable advisory flags found in the bundle source. */
export function scanBundle(code: string): string[] {
  const out: string[] = [];
  for (const { re, msg } of PATTERNS) if (re.test(code)) out.push(msg);
  return out;
}
