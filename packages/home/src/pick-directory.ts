import { existsSync } from 'node:fs';

// Thin cross-platform glue for opening the host's NATIVE folder-picker dialog and
// returning the chosen absolute path. The single process.platform branch lives HERE
// (not in feature code) per the project's platform-parity rule: callers get one uniform
// pickDirectory() with no OS conditionals.
//
// Browsers can only hand back a directory *handle* (its leaf name), never an absolute
// path, so a daemon-side native dialog is the only way to obtain a real path to use as a
// session cwd. The dialog is driven entirely through argv/env — never string
// interpolation into a shell or script — so the prompt/default values cannot inject.

export interface PickDirectoryOptions {
  /** Dialog prompt/title shown to the user. */
  prompt?: string;
  /** Absolute path the dialog opens at. Ignored if it doesn't exist. */
  defaultPath?: string;
}

interface PickerSpec {
  argv: string[];
  env?: Record<string, string>;
}

// AppleScript source is STATIC; the prompt and default location arrive as `argv`, so a
// value containing quotes/newlines can never alter the script.
const OSASCRIPT_SOURCE = [
  'on run argv',
  'set thePrompt to item 1 of argv',
  'if (count of argv) > 1 then',
  'return POSIX path of (choose folder with prompt thePrompt default location (POSIX file (item 2 of argv)))',
  'end if',
  'return POSIX path of (choose folder with prompt thePrompt)',
  'end run'
].join('\n');

// PowerShell source is STATIC; the prompt and default path arrive via env, so they cannot
// break out of the script. -STA is required for Windows Forms dialogs.
const POWERSHELL_SOURCE = [
  'Add-Type -AssemblyName System.Windows.Forms;',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
  '$d.Description = $env:MONAD_PICK_PROMPT;',
  'if ($env:MONAD_PICK_DEFAULT) { $d.SelectedPath = $env:MONAD_PICK_DEFAULT };',
  'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }'
].join(' ');

/** Per-platform picker invocation. Pure (no I/O) so the argv/env wiring is unit-testable. */
export function directoryPickerSpecs(platform: NodeJS.Platform, opts: PickDirectoryOptions = {}): PickerSpec[] {
  const prompt = opts.prompt ?? 'Choose a folder';
  const defaultPath = opts.defaultPath?.trim() || undefined;

  switch (platform) {
    case 'darwin':
      return [{ argv: ['osascript', '-e', OSASCRIPT_SOURCE, prompt, ...(defaultPath ? [defaultPath] : [])] }];
    case 'win32': {
      // Windows PowerShell (powershell.exe) ships in-box and defaults to STA; fall back to
      // PowerShell 7 (pwsh) on hosts that only have it. Both need -STA for the WinForms dialog.
      const env = { MONAD_PICK_PROMPT: prompt, MONAD_PICK_DEFAULT: defaultPath ?? '' };
      return [
        { argv: ['powershell', '-NoProfile', '-STA', '-Command', POWERSHELL_SOURCE], env },
        { argv: ['pwsh', '-NoProfile', '-STA', '-Command', POWERSHELL_SOURCE], env }
      ];
    }
    default:
      // Try zenity (GNOME) first, then kdialog (KDE) — whichever is installed.
      return [
        {
          argv: [
            'zenity',
            '--file-selection',
            '--directory',
            '--title',
            prompt,
            ...(defaultPath ? ['--filename', defaultPath.endsWith('/') ? defaultPath : `${defaultPath}/`] : [])
          ]
        },
        { argv: ['kdialog', '--getexistingdirectory', defaultPath ?? '.', '--title', prompt] }
      ];
  }
}

// A user can leave the dialog open indefinitely; cap it so a forgotten dialog can't pin a
// daemon request forever.
const DIALOG_TIMEOUT_MS = 5 * 60_000;

async function runPicker(spec: PickerSpec): Promise<string | null> {
  const proc = Bun.spawn(spec.argv, {
    stdout: 'pipe',
    stderr: 'ignore',
    env: spec.env ? { ...process.env, ...spec.env } : process.env
  });
  const timer = setTimeout(() => proc.kill(), DIALOG_TIMEOUT_MS);
  try {
    const [out, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exit !== 0) return null; // non-zero ⇒ user cancelled (or the binary errored)
    const path = out.trim();
    if (!path) return null;
    // macOS `POSIX path of` a folder returns a trailing slash; Linux/Windows don't. Strip it so the
    // returned cwd is byte-identical across OSes (but keep a lone "/" root intact).
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
  } finally {
    clearTimeout(timer);
  }
}

// Only one native dialog can be meaningfully open at a time, and stacking them lets a scripted
// caller flood the desktop — serialize so a second call no-ops while one is in flight.
let inFlight: Promise<string | null> | null = null;

/**
 * Open the host's native folder picker and resolve to the chosen absolute path, or `null`
 * if the user cancelled, a dialog is already open, or no picker binary is available. Never throws.
 */
export function pickDirectory(opts: PickDirectoryOptions = {}): Promise<string | null> {
  if (inFlight) return Promise.resolve(null);
  // A non-existent default location errors osascript (→ silent no-open); drop it so the picker
  // still appears at the OS default. Keeps directoryPickerSpecs pure (this is the only I/O).
  const defaultPath = opts.defaultPath && existsSync(opts.defaultPath) ? opts.defaultPath : undefined;
  const run = (async () => {
    for (const spec of directoryPickerSpecs(process.platform, { ...opts, defaultPath })) {
      try {
        return await runPicker(spec);
      } catch {
        // Binary missing (ENOENT) — fall through to the next candidate (e.g. zenity → kdialog).
      }
    }
    return null;
  })();
  inFlight = run;
  return run.finally(() => {
    inFlight = null;
  });
}
