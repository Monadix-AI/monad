// MemoryDir — scoped Markdown L1 store. MD is the source of truth; identity = content hash.

import type { MemoryScope } from '@monad/protocol';

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { factId, MemoryDir, projectKey, scopeOf } from '@/store/db/index.ts';

test('projectKey is filename-safe, stable, and disambiguates distinct paths', () => {
  const k = projectKey('/Users/zeke/Projects/Monad');
  expect(k).toMatch(/^[a-z0-9-]+$/); // safe to embed in MEMORY_project_<key>.md
  expect(k.startsWith('monad-')).toBe(true); // recognizable basename
  expect(projectKey('/Users/zeke/Projects/Monad')).toBe(k); // stable
  expect(projectKey('/Users/zeke/Projects/Monad/')).toBe(k); // normalized (trailing slash)
  expect(projectKey('/other/Monad')).not.toBe(k); // same basename, different path → different key
});

const roots: string[] = [];
function freshDir(): MemoryDir {
  const root = mkdtempSync(join(tmpdir(), 'memdir-'));
  roots.push(root);
  return new MemoryDir(root);
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const GLOBAL: MemoryScope = { kind: 'global', id: '*' };

test('appendFact then listFacts round-trips, and dedups identical content', () => {
  const md = freshDir();
  md.appendFact(GLOBAL, { content: 'User deploys with Bun, not Node' });
  md.appendFact(GLOBAL, { content: 'User dislikes emoji-heavy text' });
  md.appendFact(GLOBAL, { content: 'User deploys with Bun, not Node' }); // duplicate
  const facts = md.listFacts(GLOBAL);
  expect(facts.map((f) => f.content)).toEqual(['User deploys with Bun, not Node', 'User dislikes emoji-heavy text']);
  expect(facts[0]?.id).toBe(factId('User deploys with Bun, not Node'));
});

test('rejects path-traversal scope ids instead of escaping the root', () => {
  const md = freshDir();
  for (const id of ['..', '../../etc', 'a/../../b', '/abs', 'a\\b', '.']) {
    const scope: MemoryScope = { kind: 'agent', id };
    expect(() => md.writeCore(scope, 'pwned')).toThrow(/unsafe memory scope id/);
    expect(() => md.readCore(scope)).toThrow(/unsafe memory scope id/);
    expect(() => md.dropScope(scope)).toThrow(/unsafe memory scope id/);
    expect(() => md.appendFact(scope, { content: 'x' })).toThrow(/unsafe memory scope id/);
  }
  // A normal id works, and `..` embedded in a single segment (no separator) does not traverse.
  expect(() => md.writeCore({ kind: 'agent', id: 'agt_ok' }, 'fine')).not.toThrow();
  expect(() => md.writeCore({ kind: 'agent', id: 'a..b' }, 'fine')).not.toThrow();
});

test('editFact replaces by id; removeFact drops by id', () => {
  const md = freshDir();
  const a = md.appendFact(GLOBAL, { content: 'old fact' });
  md.appendFact(GLOBAL, { content: 'keep me' });
  const edited = md.editFact(GLOBAL, a.id, 'new fact');
  const editedId = edited?.id ?? '';
  expect(edited?.content).toBe('new fact');
  expect(md.listFacts(GLOBAL).map((f) => f.content)).toEqual(['new fact', 'keep me']);
  expect(md.removeFact(GLOBAL, editedId)).toBe(true);
  expect(md.listFacts(GLOBAL).map((f) => f.content)).toEqual(['keep me']);
  expect(md.removeFact(GLOBAL, 'nope')).toBe(false);
});

test('readCore/writeCore expose the raw markdown (human-editable source of truth)', () => {
  const md = freshDir();
  md.writeCore(GLOBAL, '# Memory\n\n- hand-written fact\n');
  expect(md.listFacts(GLOBAL).map((f) => f.content)).toEqual(['hand-written fact']);
});

test('scope isolation: session/agent/global write to separate files', () => {
  const md = freshDir();
  const session = scopeOf('session', 'ses_AAA');
  const agent = scopeOf('agent', 'agt_BBB');
  md.appendFact(session, { content: 'session secret' });
  md.appendFact(agent, { content: 'agent knowledge' });
  md.appendFact(GLOBAL, { content: 'global truth' });
  expect(md.listFacts(session).map((f) => f.content)).toEqual(['session secret']);
  expect(md.listFacts(agent).map((f) => f.content)).toEqual(['agent knowledge']);
  expect(md.listFacts(GLOBAL).map((f) => f.content)).toEqual(['global truth']);
});

test('dropScope deletes a scope file (session ephemerality)', () => {
  const md = freshDir();
  const session = scopeOf('session', 'ses_X');
  md.appendFact(session, { content: 'ephemeral' });
  expect(md.listFacts(session).length).toBe(1);
  md.dropScope(session);
});

test('normalized dedup — trailing punctuation / casing / whitespace collapse to one fact', () => {
  const md = freshDir();
  md.appendFact(GLOBAL, { content: 'User is an engineer' });
  md.appendFact(GLOBAL, { content: 'User is an engineer.' }); // trailing period
  md.appendFact(GLOBAL, { content: 'user is an  engineer' }); // case + double space
  const facts = md.listFacts(GLOBAL);
  expect(facts.length).toBe(1);
  expect(facts[0]?.content).toBe('User is an engineer'); // first-seen wins
  expect(factId('User is an engineer')).toBe(factId('user is an engineer.'));
});

test('appendFact heals pre-existing raw duplicates in MEMORY.md', () => {
  const root = mkdtempSync(join(tmpdir(), 'memdir-'));
  roots.push(root);
  const md = new MemoryDir(root);
  // A file written by the old exact-match logic: two near-dup bullets.
  md.writeCore(GLOBAL, '# Memory\n\n- User is an engineer\n- User is an engineer.\n');
  expect(md.listFacts(GLOBAL).length).toBe(1); // read-side dedup
  md.appendFact(GLOBAL, { content: 'Likes Bun' }); // any write heals the file
  const raw = readFileSync(join(root, 'MEMORY_global.md'), 'utf8');
  expect(raw.match(/User is an engineer/g)?.length).toBe(1);
});

test('writes are atomic — the scope file carries frontmatter + bullets after each write', () => {
  const root = mkdtempSync(join(tmpdir(), 'memdir-'));
  roots.push(root);
  const md = new MemoryDir(root);
  md.appendFact(GLOBAL, { content: 'fact one' });
  const raw = readFileSync(join(root, 'MEMORY_global.md'), 'utf8');
  expect(raw.startsWith('---')).toBe(true); // frontmatter block
});
