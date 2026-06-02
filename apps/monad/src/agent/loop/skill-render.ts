export function parseAllowedTools(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Does an `allowed-tools` pattern grant `toolName`? An argument constraint
 * (`Bash(git:*)`) is reduced to its tool name (monad gates per tool, not per argument); a
 * trailing `*` is a name prefix; otherwise it's an exact match.
 */
export function toolMatchesAllowedPattern(pattern: string, toolName: string): boolean {
  const namePart = pattern.replace(/\([^)]*\)\s*$/, '').trim();
  if (!namePart) return false;
  if (namePart.endsWith('*')) return toolName.startsWith(namePart.slice(0, -1));
  return namePart === toolName;
}

/** Matches any argument placeholder: `$ARGUMENTS`, `$ARGUMENTS[N]`, or `$N`. */
const SKILL_ARG_PLACEHOLDER = /\$ARGUMENTS(?:\[\d+\])?|\$\d+/;

/**
 * Substitute the skill-directory placeholder so a body can reference its own bundled
 * resources by absolute path (e.g. "run `${SKILL_DIR}/scripts/build.py`") — the seam that
 * makes L3 scripts actually usable. Supports `${SKILL_DIR}` and the legacy
 * `${CLAUDE_SKILL_DIR}` so cross-tool skills port unchanged. With no dir the placeholder is
 * removed (an unanchored skill has no resources to point at).
 */
export function substituteSkillDir(body: string, dir?: string): string {
  return body.replace(/\$\{(?:SKILL_DIR|CLAUDE_SKILL_DIR)\}/g, dir ?? '');
}

/**
 * Render a skill body for explicit `/name` invocation: first resolve `${SKILL_DIR}`, then
 * substitute arguments — `$ARGUMENTS[N]` / `$N` resolve to positional
 * args, `$ARGUMENTS` to the full string. If the body references NO arg placeholder at all but
 * args were passed, they are appended as an `ARGUMENTS:` line so the model still sees them.
 */
export function renderSkillBody(body: string, argString: string, dir?: string): string {
  const src = substituteSkillDir(body, dir);
  const args = splitArgs(argString);
  const referencedArgs = SKILL_ARG_PLACEHOLDER.test(src);
  let out = src
    .replace(/\$ARGUMENTS\[(\d+)\]/g, (_m, i: string) => args[Number(i)] ?? '')
    .replace(/\$(\d+)/g, (_m, i: string) => args[Number(i)] ?? '')
    .split('$ARGUMENTS')
    .join(argString);
  if (!referencedArgs && argString.trim().length > 0) {
    out = `${out}\n\nARGUMENTS: ${argString}`;
  }
  return out;
}

/**
 * Inline dynamic-context placeholder: `` !`cmd` `` recognised only at the
 * start of a line or immediately after whitespace (so `KEY=!`x`` stays literal).
 */
const SHELL_INJECT_RE = /(^|\s)!`([^`]+)`/gm;

/**
 * Pre-render `` !`cmd` `` placeholders in a skill body by running each command through the
 * injected `run` function and substituting its output. The runner is dependency-injected so
 * this stays pure and testable; the daemon supplies a real (shell) runner ONLY when the
 * operator opts in — arbitrary shell from a file is off by default. A failed command is
 * replaced with a visible marker rather than aborting the render. Output is not re-scanned,
 * so a command cannot emit a placeholder for a later pass.
 */
export async function renderShellInjections(body: string, run: (cmd: string) => Promise<string>): Promise<string> {
  const matches = [...body.matchAll(SHELL_INJECT_RE)];
  if (matches.length === 0) return body;
  let out = '';
  let last = 0;
  for (const m of matches) {
    const start = m.index ?? 0;
    const lead = m[1] ?? '';
    const cmd = m[2] ?? '';
    out += body.slice(last, start) + lead;
    try {
      out += (await run(cmd)).replace(/\n+$/, '');
    } catch {
      out += `[skill command failed: ${cmd}]`;
    }
    last = start + m[0].length;
  }
  return out + body.slice(last);
}

/** Minimal shell-style splitter: whitespace-separated, honouring single/double quotes. */
function splitArgs(input: string): string[] {
  const matches = input.match(/"([^"]*)"|'([^']*)'|(\S+)/g);
  if (!matches) return [];
  return matches.map((tok) => {
    if ((tok.startsWith('"') && tok.endsWith('"')) || (tok.startsWith("'") && tok.endsWith("'"))) {
      return tok.slice(1, -1);
    }
    return tok;
  });
}
