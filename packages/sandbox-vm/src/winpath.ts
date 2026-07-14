// Windows host ⇄ Linux guest path translation. On macOS/Linux the guest mounts each policy root at
// its host path verbatim, so argv/cwd need no rewriting. A Windows path (C:\Users\z\proj) cannot be a
// guest path, so the Windows driver mounts each root under a WSL-style drive prefix:
//
//   C:\Users\z\proj  →  /mnt/c/Users/z/proj
//
// and every host path that crosses the boundary (mount targets, cwd, PATH-like env values are NOT
// touched) is translated with the same rule, keeping the mapping bijective and predictable for the
// agent author. UNC paths (\\server\share) have no drive letter and are rejected rather than guessed.

/** True when `p` looks like an absolute Windows drive path (C:\… or C:/…). */
export function isWindowsAbsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p);
}

/** Rewrite argv tokens that ARE an absolute Windows path to their guest mount path, so a command like
 *  `cat C:\Users\z\proj\f` reaches the file at /mnt/c/... in the guest. Only a token that is entirely
 *  a drive path is rewritten (conservative — a token that merely embeds a path, e.g. `--out=C:\x`, is
 *  left alone: we can't know it's a path, and rewriting arbitrary substrings would corrupt literal
 *  args). On non-Windows this is identity (isWindowsAbsPath is false for POSIX argv). */
export function translateArgvPaths(argv: string[]): string[] {
  return argv.map((tok) => (isWindowsAbsPath(tok) ? toGuestPath(tok) : tok));
}

/** Translate an absolute Windows host path to its guest mount path (/mnt/<drive>/…). Idempotent for
 *  already-POSIX inputs (returned unchanged) so shared code paths can call it unconditionally. */
export function toGuestPath(hostPath: string): string {
  if (hostPath.startsWith('\\\\')) {
    throw new Error(`sandbox-vm: UNC path not supported as a sandbox root: ${hostPath}`);
  }
  if (!isWindowsAbsPath(hostPath)) return hostPath; // POSIX path (mac/linux caller) — passthrough
  const drive = hostPath[0]?.toLowerCase();
  const rest = hostPath
    .slice(2) // strip "C:"
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
  return `/mnt/${drive}${rest === '' ? '' : rest}`;
}
