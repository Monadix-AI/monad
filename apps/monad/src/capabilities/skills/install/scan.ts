// Advisory content scan for a fetched skill, surfaced for the default-deny consent decision (NOT a
// hard block — a skill is natural-language instructions, so a match is a flag to review, not proof
// of malice). Skills are a prompt-injection / escalation vector: they instruct the agent, can bundle
// scripts the agent might run, and can pre-declare `allowedTools`. We surface those three signals.
//
// Scan rules are maintained in scan-rules.json — add, remove, or tune patterns there without
// touching this file. `advisory: true` in that file documents that findings never auto-block.

import { lstat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import rulesConfig from './scan-rules.json';

const MAX_TEXT: number = rulesConfig.maxTextBytes;

const EXEC_EXT = new RegExp(
  `(${rulesConfig.execExtensions.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`,
  'i'
);

const DANGEROUS: { re: RegExp; msg: string }[] = [];
for (const { pattern, flags, message } of rulesConfig.rules) {
  try {
    DANGEROUS.push({ re: new RegExp(pattern, flags), msg: message });
  } catch {
    // invalid pattern in scan-rules.json — skip rather than crash the daemon
  }
}

/** Reads every file under a skill directory on disk and returns advisory scan warnings. */
export async function scanSkillDir(dir: string): Promise<string[]> {
  const name = basename(dir);
  const files = new Map<string, Uint8Array>();
  for await (const rel of new Bun.Glob('**/*').scan({ cwd: dir, onlyFiles: true })) {
    const abs = join(dir, rel);
    if ((await lstat(abs)).isSymbolicLink()) continue;
    files.set(`${name}/${rel}`, await Bun.file(abs).bytes());
  }
  return scanSkillFiles(files);
}

/** Returns advisory warnings about a skill's fetched files (path→bytes). Empty = nothing flagged. */
export function scanSkillFiles(files: Map<string, Uint8Array>): string[] {
  const warnings = new Set<string>();
  const execFiles: string[] = [];
  const dec = new TextDecoder();

  for (const [path, bytes] of files) {
    if (EXEC_EXT.test(path)) execFiles.push(path);
    if (bytes.length > MAX_TEXT || bytes.includes(0)) continue; // too big, or a NUL byte → binary
    let text: string;
    try {
      text = dec.decode(bytes);
    } catch {
      continue;
    }

    for (const { re, msg } of DANGEROUS) if (re.test(text)) warnings.add(msg);

    // `allowedTools` in a SKILL.md frontmatter block: the skill pre-declares tools to allow.
    if (basename(path) === 'SKILL.md') {
      const tools = text.match(/^---\n([\s\S]*?)\n---/)?.[1]?.match(/^allowedTools:\s*(.+)$/m)?.[1];
      if (tools) warnings.add(`"${basename(dirname(path)) || 'skill'}" pre-declares allowedTools: ${tools.trim()}`);
    }
  }

  if (execFiles.length > 0) {
    const shown = execFiles.slice(0, 5).join(', ');
    warnings.add(
      `bundles executable script(s): ${shown}${execFiles.length > 5 ? ` (+${execFiles.length - 5} more)` : ''}`
    );
  }
  return [...warnings];
}
