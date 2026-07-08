// bun test preload — forces MONAD_HOME into a repo-local, per-process temp dir unless the
// caller set one. Guarantees no test can ever write to ~/.monad on the developer's machine.
// (Most tests use an in-memory store and never touch home; this is a belt-and-suspenders guard
// for any test that calls getPaths()/initMonadHome().)

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

if (!Bun.env.MONAD_HOME) {
  const dir = join(import.meta.dir, '..', '.dev', 'test-home', String(process.pid));
  mkdirSync(dir, { recursive: true });
  Bun.env.MONAD_HOME = dir;
}
