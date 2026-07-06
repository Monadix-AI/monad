import { join } from 'node:path';

import { runDevInitCommandStep } from './command-step';

export function shouldInitCodeGraph(codeGraphAvailable: boolean, indexExists: boolean): boolean {
  return codeGraphAvailable && !indexExists;
}

export async function initCodeGraph(
  root: string,
  color: boolean,
  log: (msg: string) => void,
  warn: (msg: string) => void
): Promise<void> {
  const codeGraphBin = Bun.which('codegraph');
  const codeGraphAvailable = codeGraphBin !== null;
  const codeGraphIndexExists = await Bun.file(join(root, '.codegraph', 'codegraph.db')).exists();
  if (codeGraphBin && shouldInitCodeGraph(codeGraphAvailable, codeGraphIndexExists)) {
    const result = await runDevInitCommandStep({
      color,
      command: [codeGraphBin, 'init', '-i'],
      cwd: root,
      doneVerb: 'ready',
      label: 'CodeGraph',
      target: '.codegraph/codegraph.db',
      verb: 'indexing'
    });
    if (result.exitCode !== 0) {
      warn(`CodeGraph             init failed with exit code ${result.exitCode}`);
    }
  } else if (codeGraphAvailable) {
    log('CodeGraph             already indexed');
  }
}

// Arize Phoenix (local LLM observability backend). Single container, LLM-aware UI. Accepts OTLP
// HTTP/protobuf on 6006 (same port as the UI) — that's what the daemon exports to; 4317/4318 are
// also exposed for other OTLP clients. Idempotent: a running container is left untouched; stopped
// → restart.
export async function startPhoenix(
  color: boolean,
  log: (msg: string) => void,
  warn: (msg: string) => void
): Promise<string> {
  let otelUiUrl = '';
  try {
    const dockerAvailable = await Bun.$`docker info`
      .quiet()
      .then(() => true)
      .catch(() => false);
    if (!dockerAvailable) {
      log('Phoenix               skipped  (docker not found)');
    } else {
      const running = await Bun.$`docker inspect -f '{{.State.Running}}' phoenix`
        .quiet()
        .text()
        .then((t) => t.trim() === 'true')
        .catch(() => false);
      if (running) {
        log('Phoenix               already running');
        otelUiUrl = 'http://localhost:6006';
      } else {
        const exists = await Bun.$`docker inspect phoenix`
          .quiet()
          .then(() => true)
          .catch(() => false);
        if (exists) {
          const result = await runDevInitCommandStep({
            color,
            command: ['docker', 'start', 'phoenix'],
            doneVerb: 'restarted',
            label: 'Phoenix',
            target: 'http://localhost:6006',
            verb: 'starting'
          });
          if (result.exitCode !== 0) warn(`Phoenix               restart failed with exit code ${result.exitCode}`);
        } else {
          const imagePresent = await Bun.$`docker image inspect arizephoenix/phoenix`
            .quiet()
            .then(() => true)
            .catch(() => false);
          if (!imagePresent) {
            const pull = await runDevInitCommandStep({
              color,
              command: ['docker', 'pull', 'arizephoenix/phoenix'],
              doneVerb: 'pulled',
              label: 'Phoenix image',
              target: 'arizephoenix/phoenix',
              verb: 'pulling'
            });
            if (pull.exitCode !== 0) warn(`Phoenix               image pull failed with exit code ${pull.exitCode}`);
          }
          const run = await runDevInitCommandStep({
            color,
            command: [
              'docker',
              'run',
              '-d',
              '-p',
              '6006:6006',
              '-p',
              '4318:4318',
              '--name',
              'phoenix',
              'arizephoenix/phoenix'
            ],
            doneVerb: 'started',
            label: 'Phoenix',
            target: 'http://localhost:6006',
            verb: 'starting'
          });
          if (run.exitCode !== 0) warn(`Phoenix               start failed with exit code ${run.exitCode}`);
        }
        otelUiUrl = 'http://localhost:6006';
      }
    }
  } catch (err) {
    warn(`Phoenix               failed to start: ${err instanceof Error ? err.message : String(err)}`);
    warn('  Start it manually: docker run -d -p 6006:6006 -p 4318:4318 --name phoenix arizephoenix/phoenix');
  }
  return otelUiUrl;
}

// Mo desktop sprite (macOS). Regenerate the native atlas header from the manifest, then build the
// native Mo.app once so `bun dev` can Launch it — MoService probes the repo build in dev. macOS-only
// for now; non-fatal (skipped without clang/Xcode CLT), and only built when missing so repeat
// `bun dev` runs stay fast.
export async function buildMoSprite(
  root: string,
  color: boolean,
  log: (msg: string) => void,
  warn: (msg: string) => void
): Promise<void> {
  await runDevInitCommandStep({
    color,
    command: ['bun', 'run', join(root, 'scripts/gen-mo-atlas.ts')],
    doneVerb: 'generated',
    label: 'Mo atlas',
    target: 'apps/mo/native/common/atlas.h',
    verb: 'generating'
  });
  if (process.platform === 'darwin') {
    const moBin = join(root, 'apps/mo/native/macos/Mo.app/Contents/MacOS/mo');
    // Rebuild when the binary is missing OR any native source is newer than it — otherwise a behavior
    // change (mo.m / common/*) would silently run the stale Mo.app on the next `bun dev`.
    const sources = [
      'apps/mo/native/macos/mo.m',
      'apps/mo/native/macos/build.sh',
      'apps/mo/native/common/behavior.c',
      'apps/mo/native/common/behavior.h',
      'apps/mo/native/common/daemon.c',
      'apps/mo/native/common/daemon.h',
      'apps/mo/assets/atlas.json',
      'scripts/gen-mo-atlas.ts'
    ].map((p) => join(root, p));
    const binMtime = (await Bun.file(moBin).exists()) ? Bun.file(moBin).lastModified : 0;
    const newestSrc = Math.max(...sources.map((p) => Bun.file(p).lastModified));
    if (binMtime > 0 && binMtime >= newestSrc) {
      log('Mo sprite             up to date');
    } else {
      const hasClang = await Bun.$`command -v clang`
        .quiet()
        .then(() => true)
        .catch(() => false);
      if (!hasClang) {
        log('Mo sprite             skipped  (clang not found — run: xcode-select --install)');
      } else {
        const r = await runDevInitCommandStep({
          color,
          command: ['bash', join(root, 'apps/mo/native/macos/build.sh')],
          doneVerb: 'built',
          label: 'Mo sprite',
          target: 'apps/mo/native/macos/Mo.app',
          verb: 'building'
        });
        if (r.exitCode !== 0) warn('Mo sprite             build failed (see apps/mo)');
      }
    }
  }
}
