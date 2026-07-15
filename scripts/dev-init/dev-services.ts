import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDevInitCommandStep } from './command-step';

export type CodeGraphStatus = 'available-unindexed' | 'indexed' | 'unavailable';

export function codeGraphStatus(codeGraphAvailable: boolean, indexExists: boolean): CodeGraphStatus {
  if (!codeGraphAvailable) return 'unavailable';
  return indexExists ? 'indexed' : 'available-unindexed';
}

export async function reportCodeGraph(root: string, log: (msg: string) => void): Promise<void> {
  const codeGraphAvailable = Bun.which('codegraph') !== null;
  const codeGraphIndexExists = await Bun.file(join(root, '.codegraph', 'codegraph.db')).exists();
  const status = codeGraphStatus(codeGraphAvailable, codeGraphIndexExists);
  if (status === 'indexed') log('CodeGraph             indexed');
  if (status === 'available-unindexed') {
    log('CodeGraph             available (project owner may run: codegraph init)');
  }
}

export function isExpectedPhoenixImage(image: string): boolean {
  const normalized = image.replace(/^docker\.io\//, '');
  return (
    normalized === 'arizephoenix/phoenix' ||
    normalized.startsWith('arizephoenix/phoenix:') ||
    normalized.startsWith('arizephoenix/phoenix@')
  );
}

export function resolvePhoenixContainerImage(inspectedImage: string, listedImage: string): string {
  return inspectedImage.trim() || listedImage.trim();
}

function dockerText(args: string[]): string {
  const result = Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  return result.exitCode === 0 ? result.stdout.toString().trim() : '';
}

function listedPhoenixImage(): string {
  const rows = dockerText(['ps', '-a', '--filter', 'name=phoenix', '--format', '{{.Names}}\t{{.Image}}']);
  for (const row of rows.split('\n')) {
    const [name, image] = row.split('\t');
    if (name === 'phoenix') return image ?? '';
  }
  return '';
}

export async function withSharedDirectoryLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  timeoutMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for shared service lock ${lockPath}`);
      await Bun.sleep(100);
    }
  }
  try {
    return await action();
  } finally {
    await rm(lockPath, { force: true, recursive: true });
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
      otelUiUrl = await withSharedDirectoryLock(join(tmpdir(), 'monad-phoenix-init.lock'), async () => {
        const containerImage = resolvePhoenixContainerImage(
          dockerText(['inspect', '--format', '{{.Config.Image}}', 'phoenix']),
          listedPhoenixImage()
        );
        if (containerImage && !isExpectedPhoenixImage(containerImage)) {
          warn(`Phoenix               skipped  (container name "phoenix" belongs to ${containerImage})`);
          return '';
        }
        const running = containerImage
          ? dockerText(['inspect', '--format', '{{.State.Running}}', 'phoenix']) === 'true'
          : false;
        if (running) {
          log('Phoenix               already running (shared)');
          return 'http://localhost:6006';
        }
        if (containerImage) {
          const result = await runDevInitCommandStep({
            color,
            command: ['docker', 'start', 'phoenix'],
            doneVerb: 'restarted',
            label: 'Phoenix',
            target: 'http://localhost:6006',
            verb: 'starting'
          });
          if (result.exitCode !== 0) {
            warn(`Phoenix               restart failed with exit code ${result.exitCode}`);
            return '';
          }
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
            if (pull.exitCode !== 0) {
              warn(`Phoenix               image pull failed with exit code ${pull.exitCode}`);
              return '';
            }
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
          if (run.exitCode !== 0) {
            warn(`Phoenix               start failed with exit code ${run.exitCode}`);
            return '';
          }
        }
        return 'http://localhost:6006';
      });
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
