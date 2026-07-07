import { describe, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

const atomsRoot = join(import.meta.dir, '../../src');
const workspaceExperiencesRoot = join(atomsRoot, 'workspace-experiences');
const atomKindDirs = new Set([
  'agent-adapters',
  'channels',
  'commands',
  'connectors',
  'providers',
  'sandbox',
  'workspace-experiences'
]);
const sharedDirs = new Set(['experience', 'shared']);

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function resolveRelativeImport(root: string, from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const target = normalize(join(dirname(from), specifier));
  const candidates = [target, `${target}.ts`, `${target}.tsx`, join(target, 'index.ts'), join(target, 'index.tsx')];
  return candidates.find((candidate) => existsSync(candidate) && candidate.startsWith(root)) ?? null;
}

function topLevelDir(root: string, file: string): string | null {
  const [top] = relative(root, file).split('/');
  return top || null;
}

describe('atom kind boundaries', () => {
  test('atom kind implementations do not import other atom kind implementations', () => {
    const violations: string[] = [];

    for (const from of tsFiles(atomsRoot)) {
      if (relative(atomsRoot, from) === 'index.ts') continue;
      const fromKind = topLevelDir(atomsRoot, from);
      if (!fromKind || !atomKindDirs.has(fromKind)) continue;

      const source = readFileSync(from, 'utf8');
      const imports = source.matchAll(/import(?:\s+type)?[\s\S]*?from\s*['"]([^'"]+)['"]/g);

      for (const match of imports) {
        const specifier = match[1];
        if (!specifier) continue;
        const to = resolveRelativeImport(atomsRoot, from, specifier);
        if (!to) continue;
        const toKind = topLevelDir(atomsRoot, to);
        if (toKind && fromKind !== toKind && atomKindDirs.has(toKind)) {
          violations.push(`${relative(atomsRoot, from)} -> ${relative(atomsRoot, to)}`);
        }
      }
    }
  });
});

describe('workspace experience boundaries', () => {
  test('concrete experience implementations do not import each other', () => {
    const concreteDirs = new Set(
      readdirSync(workspaceExperiencesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => !sharedDirs.has(name))
    );
    const violations: string[] = [];

    for (const from of [...concreteDirs].flatMap((dir) => tsFiles(join(workspaceExperiencesRoot, dir)))) {
      const fromDir = topLevelDir(workspaceExperiencesRoot, from);
      const source = readFileSync(from, 'utf8');
      const imports = source.matchAll(/import(?:\s+type)?[\s\S]*?from\s*['"]([^'"]+)['"]/g);

      for (const match of imports) {
        const specifier = match[1];
        if (!specifier) continue;
        const to = resolveRelativeImport(workspaceExperiencesRoot, from, specifier);
        if (!to) continue;
        const toDir = topLevelDir(workspaceExperiencesRoot, to);
        if (fromDir && toDir && fromDir !== toDir && concreteDirs.has(toDir)) {
          violations.push(`${relative(workspaceExperiencesRoot, from)} -> ${relative(workspaceExperiencesRoot, to)}`);
        }
      }
    }
  });
});
