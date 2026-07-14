import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MaskedFileStore } from '../../src/credential-mask-files.ts';
import { SENTINEL_PREFIX, SentinelRegistry } from '../../src/credential-sentinel.ts';

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'credmask-src-'));
  const path = join(dir, 'secret');
  writeFileSync(path, content);
  return path;
}

describe('whole-file mask', () => {
  test('fake file contains the sentinel and NOT the real value; registry got the real value', () => {
    const real = 'ghp_realsupersecret1234567890';
    const path = tmpFile(real);
    const registry = new SentinelRegistry();
    const store = new MaskedFileStore();

    const bind = store.add(registry, { name: 'GH_TOKEN', realPath: path, injectHosts: ['api.github.com'] });
    if (!bind) throw new Error('expected a bind');
    const fakeContent = readFileSync(bind.fake, 'utf8');
    expect(fakeContent.startsWith(SENTINEL_PREFIX)).toBe(true);
    expect(fakeContent.includes(real)).toBe(false);

    // The registry swaps the sentinel back to the real value for the injectHost.
    expect(registry.substitute('api.github.com', fakeContent)).toBe(real);
    // A non-injectHost keeps the sentinel (no leak).
    expect(registry.substitute('evil.example.com', fakeContent)).toBe(fakeContent);

    store.dispose();
  });
});

describe('extract mask', () => {
  test('masks only the matched span, leaving the rest of the JSON intact', () => {
    const real = 'sk-realkeyvalue-XYZ';
    const json = JSON.stringify({ apiKey: real, endpoint: 'https://api.openai.com', timeout: 30 });
    const path = tmpFile(json);
    const registry = new SentinelRegistry();
    const store = new MaskedFileStore();

    const bind = store.add(registry, {
      name: 'OPENAI',
      realPath: path,
      injectHosts: ['api.openai.com'],
      extract: '"apiKey":"([^"]+)"'
    });
    if (!bind) throw new Error('expected a bind');
    const fakeContent = readFileSync(bind.fake, 'utf8');
    // Real key gone; the rest of the JSON (endpoint, timeout) is byte-identical.
    expect(fakeContent.includes(real)).toBe(false);
    expect(fakeContent.includes('"endpoint":"https://api.openai.com"')).toBe(true);
    expect(fakeContent.includes('"timeout":30')).toBe(true);
    // Fake is still valid JSON and the apiKey field holds a sentinel.
    const parsed = JSON.parse(fakeContent) as { apiKey: string };
    expect(parsed.apiKey.startsWith(SENTINEL_PREFIX)).toBe(true);
    // Egress substitution restores the original bytes for the injectHost.
    expect(registry.substitute('api.openai.com', fakeContent)).toBe(json);

    store.dispose();
  });

  test('extract matching nothing skips the entry (no bind)', () => {
    const path = tmpFile('token = abc123');
    const registry = new SentinelRegistry();
    const store = new MaskedFileStore();
    const bind = store.add(registry, {
      name: 'X',
      realPath: path,
      injectHosts: ['h'],
      extract: 'NOMATCH:([^ ]+)'
    });
    expect(bind).toBeUndefined();
    expect(registry.size).toBe(0);
    store.dispose();
  });
});

describe('lifecycle', () => {
  test('dispose removes the temp dir', () => {
    const path = tmpFile('secret');
    const registry = new SentinelRegistry();
    const store = new MaskedFileStore();
    store.add(registry, { name: 'A', realPath: path, injectHosts: ['h'] });
    const dir = store.dirPath;
    if (!dir) throw new Error('expected a temp dir');
    expect(existsSync(dir)).toBe(true);
    store.dispose();
    expect(existsSync(dir)).toBe(false);
  });

  test('missing file is skipped rather than throwing', () => {
    const registry = new SentinelRegistry();
    const store = new MaskedFileStore();
    const bind = store.add(registry, { name: 'A', realPath: '/no/such/file/here', injectHosts: ['h'] });
    expect(bind).toBeUndefined();
    store.dispose();
  });
});

describe('fail-closed: a credential file that cannot be masked is denied, never left readable', () => {
  test('extract that matches nothing → no bind, real path added to denyPaths', () => {
    const path = tmpFile('token = ghp_realsecret_value_123');
    const registry = new SentinelRegistry();
    const store = new MaskedFileStore();
    // A regex that captures nothing in this file.
    const bind = store.add(registry, { name: 'A', realPath: path, injectHosts: ['h'], extract: 'NOPE=(\\w+)' });
    expect(bind).toBeUndefined();
    expect(store.list).toHaveLength(0);
    // The declared credential file must be denied (fail-closed), not silently readable. denyPaths holds
    // the realpath'd source (macOS tmpdir symlinks to /private), so match on the basename.
    expect(store.denyPaths.some((p) => p.endsWith('secret'))).toBe(true);
    store.dispose();
  });

  test('a missing declared credential file is still denied', () => {
    const registry = new SentinelRegistry();
    const store = new MaskedFileStore();
    store.add(registry, { name: 'A', realPath: '/no/such/file/here', injectHosts: ['h'] });
    expect(store.denyPaths).toContain('/no/such/file/here');
    store.dispose();
  });
});
