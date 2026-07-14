// Layered-memory L1 store (design A) — CLI-agent-style machine-written Markdown in ONE flat dir,
// keyed by scope, with a cheap injectable index. MD is the source of truth (human-readable, hand-
// editable); there is no SQLite event table for L1 (deliberate divergence — see docs/internals/memory.md).
//
//   <home>/memory/MEMORY.md                  ← index (titles + descriptions); the ONLY part injected
//   <home>/memory/MEMORY_global.md           ← cross-agent (the instance's one user)
//   <home>/memory/MEMORY_agent_<agentId>.md  ← persists for that agent across sessions
//   <home>/memory/MEMORY_session_<sid>.md    ← session-local; dropped with the session
//
// Each scope file carries frontmatter (name/description/metadata) in the same shape the external agent uses;
// the agent supplies only fact text, the store stamps provenance (scope/updated/count). A fact's
// identity is the hash of its trimmed content — stable across reads, since the MD world has no event id.

import type { Fact, MemoryScope, ScopeKind } from '@monad/protocol';

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const INDEX_FILE = 'MEMORY.md';

export interface MemoryFactInput {
  content: string;
  provClass?: 'user' | 'machine';
}

// Dedup key: lowercase, NFC, collapse inner whitespace, drop trailing terminal/separator punctuation.
// So "User is an engineer", "User is an engineer.", and "user is an  engineer" map to one fact.
// Deliberately conservative — no stemming/synonyms (that is consolidation's / L2's job).
function normalizeFact(content: string): string {
  return content
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;:。！？，；：、]+$/u, '')
    .trim();
}

/** Short, stable id for a fact = first 12 hex of sha256(normalized content). */
export function factId(content: string): string {
  return createHash('sha256').update(normalizeFact(content)).digest('hex').slice(0, 12);
}

/** Stable, filename-safe id for a workspace = sanitized basename + a hash of the absolute path, so
 *  `project:<key>` is both recognizable (which project) and unique (full path disambiguates). The
 *  scope id becomes a filename segment, so the result is `[a-z0-9-]` only. */
export function projectKey(cwd: string): string {
  const abs = resolve(cwd);
  const base =
    basename(abs)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'project';
  return `${base}-${createHash('sha256').update(abs).digest('hex').slice(0, 6)}`;
}

// The scope id becomes part of an on-disk filename under the memory root. It arrives straight from
// the control API, so this is the authoritative containment check: reject anything that could escape
// the root via traversal (`..`), an empty/dot segment, or separator/NUL injection. A single segment
// with no separators and not `.`/`..` cannot escape `join(root, "MEMORY_<kind>_<id>.md")`.
function assertSafeScopeId(id: string): void {
  if (id === '' || id === '.' || id === '..' || /[/\\\0]/.test(id)) {
    throw new Error(`unsafe memory scope id: ${JSON.stringify(id)}`);
  }
}

/** Flat per-scope filename. global → MEMORY_global.md; agent/session → MEMORY_<kind>_<id>.md. */
function scopeFile(scope: MemoryScope): string {
  if (scope.kind === 'global') return 'MEMORY_global.md';
  assertSafeScopeId(scope.id);
  return `MEMORY_${scope.kind}_${scope.id}.md`;
}

function defaultDescription(scope: MemoryScope): string {
  if (scope.kind === 'global') return 'Shared facts about the user, usable by all agents.';
  if (scope.kind === 'agent') return `Facts specific to agent ${scope.id}.`;
  if (scope.kind === 'project') return `Facts specific to the workspace (${scope.id}).`;
  return `Session-local memory (${scope.id}).`;
}

function scopeName(scope: MemoryScope): string {
  return scope.kind === 'global' ? 'global' : `${scope.kind}-${scope.id}`;
}

interface ScopeMeta {
  description: string;
  updated: string;
  facts: number;
}

/** Strip a leading `---\n…\n---` frontmatter block, returning the parsed bits we care about + the
 *  remaining body. Lenient: a file with no frontmatter (e.g. a raw UI edit) yields empty meta + the
 *  whole text as body. We regenerate frontmatter on every structured write, so parse fragility is low-stakes. */
function splitFrontmatter(text: string): { description: string; body: string } {
  if (!text.startsWith('---')) return { description: '', body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { description: '', body: text };
  const fm = text.slice(3, end);
  const body = text.slice(text.indexOf('\n', end + 1) + 1);
  const m = /^\s*description:\s*(.*\S)\s*$/m.exec(fm);
  let description = m?.[1]?.trim() ?? '';
  if (
    (description.startsWith('"') && description.endsWith('"')) ||
    (description.startsWith("'") && description.endsWith("'"))
  )
    description = description.slice(1, -1);
  return { description, body };
}

/** Parse bullet lines into facts (dedup by normalized id). Headers/prose are ignored. */
function parseFacts(body: string, scope: MemoryScope): Fact[] {
  const facts: Fact[] = [];
  const seen = new Set<string>();
  for (const raw of body.split('\n')) {
    const m = /^[-*]\s+(.*\S)\s*$/.exec(raw);
    if (!m) continue;
    const content = (m[1] ?? '').trim();
    if (!content) continue;
    const id = factId(content);
    if (seen.has(id)) continue;
    seen.add(id);
    facts.push({ id, content, scope, provClass: 'machine' });
  }
  return facts;
}

function renderScopeFile(scope: MemoryScope, description: string, updated: string, contents: string[]): string {
  const desc = description.includes(':') || description.includes('"') ? JSON.stringify(description) : description;
  const head = [
    '---',
    `name: ${scopeName(scope)}`,
    `description: ${desc}`,
    'metadata:',
    `  scope: ${scope.kind}`,
    `  updated: ${updated}`,
    `  facts: ${contents.length}`,
    '---',
    ''
  ];
  const bullets = contents.length ? contents.map((c) => `- ${c}`) : ['(no facts yet)'];
  return `${head.join('\n')}${bullets.join('\n')}\n`;
}

/**
 * Scoped Markdown memory store (flat dir). Single-writer (the daemon); writes are atomic (tmp +
 * rename) so a crash never leaves a half-written file. Every structured write re-stamps the scope
 * file's frontmatter and regenerates the injectable index. Pure file I/O — no SQLite.
 */
export class MemoryDir {
  constructor(
    private readonly root: string,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  private path(scope: MemoryScope): string {
    return join(this.root, scopeFile(scope));
  }

  /** Raw scope-file text incl. frontmatter (empty string when absent). */
  readCore(scope: MemoryScope): string {
    const p = this.path(scope);
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }

  /** Overwrite a scope file verbatim (UI direct-edit path), then refresh the index. Atomic. */
  writeCore(scope: MemoryScope, md: string): void {
    this.atomicWrite(this.path(scope), md);
    this.regenerateIndex();
  }

  /** Facts parsed from a scope file's body. */
  listFacts(scope: MemoryScope): Fact[] {
    return parseFacts(splitFrontmatter(this.readCore(scope)).body, scope);
  }

  /** Preserve a scope's human-authored description across structured rewrites. */
  private descriptionOf(scope: MemoryScope): string {
    const existing = splitFrontmatter(this.readCore(scope)).description;
    return existing || defaultDescription(scope);
  }

  private write(scope: MemoryScope, contents: string[], description?: string): void {
    const desc = description ?? this.descriptionOf(scope);
    this.atomicWrite(this.path(scope), renderScopeFile(scope, desc, this.now(), contents));
    this.regenerateIndex();
  }

  /** Append a fact unless a normalized-equal one already exists. Returns the canonical fact. */
  appendFact(scope: MemoryScope, input: MemoryFactInput): Fact {
    const content = input.content.trim();
    const id = factId(content);
    const facts = this.listFacts(scope);
    const existing = facts.find((f) => f.id === id);
    if (!existing) this.write(scope, [...facts.map((f) => f.content), content]);
    return { id, content: existing?.content ?? content, scope, provClass: input.provClass ?? 'machine' };
  }

  /** Replace a scope's entire fact set (the consolidation / LLM-rewrite path). */
  replaceFacts(scope: MemoryScope, contents: string[], description?: string): void {
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const raw of contents) {
      const content = raw.trim();
      if (!content) continue;
      const id = factId(content);
      if (seen.has(id)) continue;
      seen.add(id);
      kept.push(content);
    }
    this.write(scope, kept, description);
  }

  /** Replace a fact's content by id. Returns the new fact, or null when the id is unknown. */
  editFact(scope: MemoryScope, id: string, content: string): Fact | null {
    const next = content.trim();
    const facts = this.listFacts(scope);
    const idx = facts.findIndex((f) => f.id === id);
    if (idx < 0) return null;
    this.write(
      scope,
      facts.map((f, i) => (i === idx ? next : f.content))
    );
    return { id: factId(next), content: next, scope, provClass: 'machine' };
  }

  /** Drop a fact by id. Returns true when something was removed. */
  removeFact(scope: MemoryScope, id: string): boolean {
    const facts = this.listFacts(scope);
    const kept = facts.filter((f) => f.id !== id);
    if (kept.length === facts.length) return false;
    this.write(
      scope,
      kept.map((f) => f.content)
    );
    return true;
  }

  /** Delete a scope file (session teardown / forget-all), then refresh the index. */
  dropScope(scope: MemoryScope): void {
    rmSync(this.path(scope), { force: true });
    this.regenerateIndex();
  }

  /** Every scope that currently has a file on disk (parsed from filenames). */
  listScopes(): MemoryScope[] {
    if (!existsSync(this.root)) return [];
    const out: MemoryScope[] = [];
    for (const file of readdirSync(this.root)) {
      if (!file.startsWith('MEMORY_') || !file.endsWith('.md')) continue;
      const stem = file.slice('MEMORY_'.length, -'.md'.length);
      if (stem === 'global') {
        out.push({ kind: 'global', id: '*' });
        continue;
      }
      const sep = stem.indexOf('_'); // kind_id; ids may contain '_', so split on the FIRST one
      if (sep < 0) continue;
      const kind = stem.slice(0, sep);
      const id = stem.slice(sep + 1);
      if ((kind === 'agent' || kind === 'project' || kind === 'session') && id) out.push({ kind, id });
    }
    return out;
  }

  /** The injectable index: one line per durable scope file (global + agents; sessions excluded). */
  readIndex(): string {
    return existsSync(join(this.root, INDEX_FILE)) ? readFileSync(join(this.root, INDEX_FILE), 'utf8') : '';
  }

  private regenerateIndex(): void {
    if (!existsSync(this.root)) return;
    const rows: { label: string; meta: ScopeMeta }[] = [];
    for (const file of readdirSync(this.root)) {
      if (!file.startsWith('MEMORY_') || !file.endsWith('.md')) continue;
      if (file.startsWith('MEMORY_session_')) continue; // ephemeral, not advertised
      const text = readFileSync(join(this.root, file), 'utf8');
      const { description, body } = splitFrontmatter(text);
      const count = body.split('\n').filter((l) => /^[-*]\s+\S/.test(l) && !l.includes('(no facts yet)')).length;
      const updM = /^\s*updated:\s*(.*\S)\s*$/m.exec(text);
      const label = file
        .replace(/^MEMORY_/, '')
        .replace(/\.md$/, '')
        .replace(/_/, ':');
      rows.push({ label, meta: { description, updated: updM?.[1]?.trim() ?? '', facts: count } });
    }
    rows.sort((a, b) => a.label.localeCompare(b.label));
    const lines = ['# Memory Index', ''];
    if (rows.length === 0) lines.push('_(no memory recorded yet)_');
    else {
      lines.push('Dynamic memory — read a scope with the `memory` tool (action `view`) before relying on it.', '');
      for (const { label, meta } of rows) {
        const day = meta.updated.slice(0, 10);
        const when = day ? ` · updated ${day}` : '';
        const desc = meta.description ? ` — ${meta.description}` : '';
        lines.push(`- **${label}** (${meta.facts} facts${when})${desc}`);
      }
    }
    this.atomicWrite(join(this.root, INDEX_FILE), `${lines.join('\n')}\n`);
  }

  private atomicWrite(p: string, md: string): void {
    mkdirSync(this.root, { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, md);
    renameSync(tmp, p);
  }
}

/** Build a MemoryScope from wire parts (`global` id is normalized to '*'). */
export function scopeOf(kind: ScopeKind, id: string): MemoryScope {
  return { kind, id: kind === 'global' ? '*' : id };
}
