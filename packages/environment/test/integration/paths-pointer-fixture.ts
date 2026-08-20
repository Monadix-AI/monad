import { mkdirSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { getRootPointerPath } from '../../src/paths.ts';

export interface PointerFixture {
  fakeHome: string;
  originalPointer: string | null;
  remove(): Promise<void>;
  restore(): Promise<void>;
  write(content: string): void;
}

export async function pointerFixture(): Promise<PointerFixture> {
  const env = { ...Bun.env };
  const fakeHome = join(tmpdir(), `monad-home-ptr-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  Bun.env.HOME = fakeHome;
  Bun.env.USERPROFILE = fakeHome;
  Bun.env.APPDATA = join(fakeHome, 'AppData', 'Roaming');
  const pointerPath = getRootPointerPath();
  let originalPointer: string | null = null;
  try {
    originalPointer = await Bun.file(pointerPath).text();
  } catch {
    originalPointer = null;
  }

  return {
    fakeHome,
    originalPointer,
    async remove() {
      await rm(pointerPath, { force: true });
    },
    async restore() {
      if (originalPointer === null) await rm(pointerPath, { force: true });
      else await writeFile(pointerPath, originalPointer);
      await rm(fakeHome, { recursive: true, force: true });
      Object.assign(Bun.env, env);
      for (const key of ['MONAD_HOME', 'NODE_ENV', 'XDG_DATA_HOME', 'HOME', 'USERPROFILE', 'APPDATA']) {
        if (!(key in env)) delete Bun.env[key];
      }
    },
    write(content) {
      mkdirSync(dirname(pointerPath), { recursive: true });
      writeFileSync(pointerPath, content);
    }
  };
}
