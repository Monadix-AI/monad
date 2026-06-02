import { expect, test } from 'bun:test';
import { join } from 'node:path';

const daemonRoot = join(import.meta.dir, '..', '..', 'src');
const observationConsumers = [
  'services/mesh-agent/host/index.ts',
  'services/mesh-agent/host/observation-resolve.ts',
  'handlers/session/ui-projection-helpers.ts'
];

test('daemon observation consumers do not import built-in atom implementations', async () => {
  const sources = await Promise.all(
    observationConsumers.map(async (file) => ({ file, source: await Bun.file(join(daemonRoot, file)).text() }))
  );
  // presence-ok: this package boundary is the behavior under test.
  expect(sources.filter(({ source }) => source.includes("from '@monad/atoms/"))).toEqual([]);
});
