import { expect, test } from 'bun:test';
import { relative } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const allowed = new Set([
  'src/store/db/index.ts',
  'src/store/db/message-mutations.ts',
  'src/store/db/messages.ts',
  'src/store/db/sessions.ts'
]);

test('runtime message producers cannot bypass Message Ingress', async () => {
  const violations: string[] = [];
  for await (const path of new Bun.Glob('src/**/*.ts').scan({ cwd: root, absolute: true })) {
    const file = relative(root, path);
    if (allowed.has(file) || file.endsWith('migrations.generated.ts')) continue;
    const source = await Bun.file(path).text();
    const lines = source.split('\n');
    for (const [index, line] of lines.entries()) {
      if (
        /\.(?:insertMessage|setGenStatus)\s*\(/.test(line) ||
        /(?:INSERT|UPDATE|DELETE FROM) messages\b/i.test(line)
      ) {
        violations.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
