import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../../../../..');
const daemonHandlersPath = join(repoRoot, 'apps/monad/src/handlers/daemon-handlers/index.ts');

describe('daemon handler generated assets', () => {
  test('license data import resolves to the generated license inventory', () => {
    const source = readFileSync(daemonHandlersPath, 'utf8');
    const match = source.match(/from ['"](?<path>[^'"]*generated\/licenses\.json)['"]/);

    expect(match?.groups?.path).toBe('../../../generated/licenses.json');
    expect(existsSync(resolve(dirname(daemonHandlersPath), match?.groups?.path ?? ''))).toBe(true);
  });
});
