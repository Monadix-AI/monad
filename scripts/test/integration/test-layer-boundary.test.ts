import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '../../..');
const integrationScript =
  'bun ../../scripts/quiet-run.ts bun ../../scripts/bun-test.ts test/integration/ --only-failures';
const infrastructureMarkers = [
  { boundary: 'daemon handler fixture', pattern: /\bbuildHandlers\b/ },
  { boundary: 'daemon HTTP transport', pattern: /\bcreateHttpTransport\b/ },
  {
    boundary: 'host filesystem',
    pattern: /(?:from\s+|import\()\s*['"]node:fs(?:\/promises)?['"]|Bun\.(?:file|write)\s*\(/
  },
  {
    boundary: 'process or listener',
    pattern:
      /(?:from\s+|import\()\s*['"]node:(?:child_process|http|https|net|tls)['"]|Bun\.(?:serve|spawn|spawnSync)\b|Bun\.\$|import\s*{[^}]*\$[^}]*}\s*from\s*['"]bun['"]/
  },
  {
    boundary: 'process-backed tool',
    pattern: /\b(?:connectMcpServer|shellExecTool|processControlTool|KvServer)\b/
  },
  {
    boundary: 'SQLite database',
    pattern: /from ['"]bun:sqlite['"]|\b(?:createStore|LawStore|GraphStore)\b/
  }
];

test('migrated unit domains do not cross local infrastructure boundaries', async () => {
  const violations: Array<{ boundary: string; file: string }> = [];
  for (const directory of await unitDirectories()) {
    const files = (await readdir(directory, { recursive: true })).filter((file) => /\.test\.[cm]?[jt]sx?$/.test(file));
    await Promise.all(
      files.map(async (file) => {
        const path = join(directory, file);
        const source = await Bun.file(path).text();
        for (const marker of infrastructureMarkers) {
          if (marker.pattern.test(source)) {
            violations.push({ boundary: marker.boundary, file: relative(root, path) });
          }
        }
      })
    );
  }

  // artifact-ok: this architecture audit reports the exact unit files that must move to integration
  expect(violations.sort((left, right) => left.file.localeCompare(right.file))).toEqual([]);
});

test('every workspace integration directory is executed by its package script', async () => {
  const violations: Array<{ actual: unknown; expected: string; workspace: string }> = [];
  for (const workspace of await workspaceDirectories()) {
    const integrationDirectory = join(workspace, 'test/integration');
    try {
      await readdir(integrationDirectory);
    } catch {
      continue;
    }
    const manifest = JSON.parse(await Bun.file(join(workspace, 'package.json')).text()) as {
      scripts?: Record<string, unknown>;
    };
    if (manifest.scripts?.['test:integration'] !== integrationScript) {
      violations.push({
        actual: manifest.scripts?.['test:integration'],
        expected: integrationScript,
        workspace: relative(root, workspace)
      });
    }
  }

  // artifact-ok: this architecture audit reports the exact integration directory missing from the workspace command
  expect(violations).toEqual([]);
});

test('test registration cannot terminate a whole Bun suite as a dependency skip', async () => {
  const violations: Array<{ file: string; line: number }> = [];
  for (const directory of await testDirectories()) {
    const files = (await readdir(directory, { recursive: true })).filter((file) => /\.test\.[cm]?[jt]sx?$/.test(file));
    await Promise.all(
      files.map(async (file) => {
        const path = join(directory, file);
        const source = await Bun.file(path).text();
        const registration = source.search(/^\s*(?:describe|test)(?:\.|\()/m);
        const prefix = registration === -1 ? source : source.slice(0, registration);
        prefix.split('\n').forEach((line, index) => {
          if (!/^\s*(?:if\b.*)?process\.exit\(0\);\s*$/.test(line)) return;
          if (/^\s*if \(process\.platform .+\) process\.exit\(0\);\s*$/.test(line)) return;
          violations.push({ file: relative(root, path), line: index + 1 });
        });
      })
    );
  }

  // artifact-ok: this architecture audit identifies suite-level exits before Bun registers test cases
  expect(violations.sort((left, right) => left.file.localeCompare(right.file))).toEqual([]);
});

async function unitDirectories(): Promise<string[]> {
  const directories = [join(root, 'scripts/test/unit')];
  for (const workspace of await workspaceDirectories()) {
    const candidate = join(workspace, 'test/unit');
    try {
      await readdir(candidate);
      directories.push(candidate);
    } catch {}
  }
  return directories;
}

async function workspaceDirectories(): Promise<string[]> {
  const directories: string[] = [];
  for (const group of ['apps', 'packages']) {
    const workspaces = await readdir(join(root, group), { withFileTypes: true });
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue;
      directories.push(join(root, group, workspace.name));
    }
  }
  return directories;
}

async function testDirectories(): Promise<string[]> {
  const directories = [join(root, 'scripts/test')];
  for (const workspace of await workspaceDirectories()) {
    const candidate = join(workspace, 'test');
    try {
      await readdir(candidate);
      directories.push(candidate);
    } catch {}
  }
  return directories;
}
