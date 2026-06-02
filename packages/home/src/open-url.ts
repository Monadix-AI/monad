// Thin cross-platform glue for opening a URL in the user's default browser. The single
// process.platform branch lives HERE (not sprinkled in feature code) per the project's
// platform-parity rule: callers get one uniform openUrl() with no OS conditionals.
//
// Windows must invoke `start` through `cmd /c` — `start` is a shell builtin, not an
// executable, so spawning it directly (e.g. ['start', url]) silently fails. The empty
// string after `start` is its window-title argument, which keeps URLs with spaces/quotes
// from being mistaken for the title.
function browserArgv(url: string): string[] {
  switch (process.platform) {
    case 'darwin':
      return ['open', url];
    case 'win32':
      return ['cmd', '/c', 'start', '', url];
    default:
      return ['xdg-open', url];
  }
}

/** Launch the default browser at `url`, detached. Returns false if no opener is available. */
export function openUrl(url: string): boolean {
  try {
    Bun.spawn(browserArgv(url), { stdio: ['ignore', 'ignore', 'ignore'] }).unref();
    return true;
  } catch {
    return false; // no opener binary / no desktop environment
  }
}
