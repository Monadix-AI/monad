#!/usr/bin/env bun
// Personal agent overlay generator.
//
// Source of truth: .rulesync.local/rules.md (gitignored, per-machine).
// Fans it out into each tool's *native, additive, gitignored* local slot so your
// personal rules layer on top of the team's committed AGENTS.md / CLAUDE.md without
// ever touching the repo. No-ops cleanly when the source is absent, so teammates
// who never created one are unaffected.

const SRC = '.rulesync.local/rules.md';

const src = Bun.file(SRC);
if (!(await src.exists())) {
  process.exit(0);
}

const body = (await src.text()).trim();
if (!body) {
  process.exit(0);
}

const note =
  '<!-- GENERATED from .rulesync.local/rules.md by `bun run agents:local`. ' +
  'Personal & gitignored — edit the source, not this file. -->';

const targets: Array<{ path: string; content: string }> = [
  // Some tools read local overlays in addition to the shared generated instructions.
  { path: 'CLAUDE.local.md', content: `${note}\n\n${body}\n` },
  // Cursor reads every .mdc under .cursor/rules/; this one sorts after the team rule.
  {
    path: '.cursor/rules/99-personal.local.mdc',
    content: `---\ndescription: Personal local rules (not shared)\nalwaysApply: true\n---\n\n${note}\n\n${body}\n`
  }
];

for (const { path, content } of targets) await Bun.write(path, content);
