#!/usr/bin/env bun

export interface ResolveReleaseRangeOptions {
  cwd?: string;
  tag: string;
  target: string;
}

export interface ReleaseRange {
  previousTag: string | null;
  range: string;
  targetSha: string;
}

const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-(?:beta\.\d+|nightly\.[0-9A-Za-z.+-]+))?$/;
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stderr: 'pipe', stdout: 'pipe' });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.toString().trimEnd();
}

export function resolveReleaseRange(options: ResolveReleaseRangeOptions): ReleaseRange {
  const cwd = options.cwd ?? process.cwd();
  if (!RELEASE_TAG.test(options.tag)) throw new Error(`invalid release tag: ${options.tag}`);

  const targetSha = git(['rev-parse', '--verify', `${options.target}^{commit}`], cwd);
  const stableRelease = STABLE_TAG.test(options.tag);
  const tags = git(['tag', '--merged', targetSha], cwd)
    .split('\n')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== options.tag && RELEASE_TAG.test(tag) && (!stableRelease || STABLE_TAG.test(tag)));

  const candidates = tags.map((tag) => ({
    distance: Number.parseInt(git(['rev-list', '--count', `${tag}..${targetSha}`], cwd), 10),
    stable: STABLE_TAG.test(tag),
    tag
  }));
  candidates.sort((left, right) => {
    if (left.distance !== right.distance) return left.distance - right.distance;
    if (left.stable !== right.stable) return left.stable ? -1 : 1;
    return right.tag.localeCompare(left.tag, 'en', { numeric: true });
  });

  const previousTag = candidates[0]?.tag ?? null;
  return {
    previousTag,
    range: previousTag ? `${previousTag}..${targetSha}` : targetSha,
    targetSha
  };
}

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

if (import.meta.main) {
  const result = resolveReleaseRange({ tag: argument('tag'), target: argument('target') });
  process.stdout.write(
    `${JSON.stringify({ 'previous-tag': result.previousTag ?? '', range: result.range, sha: result.targetSha })}\n`
  );
}
