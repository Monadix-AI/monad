#!/usr/bin/env bun

interface ReleaseCommit {
  sha: string;
  subject: string;
  type: string;
}

export interface GenerateReleaseChangelogOptions {
  cwd?: string;
  output?: string;
  repository: string;
  tag: string;
  target: string;
}

export interface GeneratedReleaseChangelog {
  body: string;
  commits: ReleaseCommit[];
  previousTag: string | null;
  targetSha: string;
}

const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CONVENTIONAL_COMMIT = /^([a-z][a-z0-9-]*)(?:\([^()\r\n]+\))?!?: .+$/;
const CHANGELOG_SECTIONS = [
  { title: 'Features', types: ['feat'] },
  { title: 'Bug Fixes', types: ['fix'] },
  { title: 'Performance', types: ['perf'] },
  { title: 'Refactors', types: ['refactor'] },
  { title: 'Documentation', types: ['docs'] },
  { title: 'Tests', types: ['test'] },
  { title: 'Build System', types: ['build'] },
  { title: 'Continuous Integration', types: ['ci'] },
  { title: 'Styles', types: ['style'] },
  { title: 'Maintenance', types: ['chore'] },
  { title: 'Reverts', types: ['revert'] }
] as const;

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stderr: 'pipe',
    stdout: 'pipe'
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.toString().trimEnd();
}

function previousReleaseTag(cwd: string, currentTag: string, targetSha: string): string | null {
  const stableRelease = STABLE_TAG.test(currentTag);
  const tags = git(['tag', '--merged', targetSha], cwd)
    .split('\n')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== currentTag && RELEASE_TAG.test(tag) && (!stableRelease || STABLE_TAG.test(tag)));

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

  return candidates[0]?.tag ?? null;
}

function releaseCommits(cwd: string, previousTag: string | null, targetSha: string): ReleaseCommit[] {
  const range = previousTag ? `${previousTag}..${targetSha}` : targetSha;
  const log = git(['log', '--reverse', '--topo-order', '--format=%H%x09%s', range], cwd);
  if (!log) return [];
  return log.split('\n').flatMap((line) => {
    const separator = line.indexOf('\t');
    if (separator <= 0) throw new Error(`unexpected git log record: ${line}`);
    const sha = line.slice(0, separator);
    const subject = line.slice(separator + 1);
    const type = subject.match(CONVENTIONAL_COMMIT)?.[1];
    return type ? [{ sha, subject, type }] : [];
  });
}

function changelogSections(commits: ReleaseCommit[], baseUrl: string): string[] {
  const recognizedTypes = new Set<string>(CHANGELOG_SECTIONS.flatMap(({ types }) => types));
  const sections = [
    ...CHANGELOG_SECTIONS.map(({ title, types }) => ({
      commits: commits.filter((commit) => (types as readonly string[]).includes(commit.type)),
      title
    })),
    { commits: commits.filter((commit) => !recognizedTypes.has(commit.type)), title: 'Other Changes' }
  ];

  return sections.flatMap(({ commits: sectionCommits, title }) => {
    if (sectionCommits.length === 0) return [];
    return [
      `### ${title}`,
      '',
      ...sectionCommits.map(({ sha, subject }) => `* ${subject} ([\`${sha.slice(0, 7)}\`](${baseUrl}/commit/${sha}))`),
      ''
    ];
  });
}

export async function generateReleaseChangelog(
  options: GenerateReleaseChangelogOptions
): Promise<GeneratedReleaseChangelog> {
  const cwd = options.cwd ?? process.cwd();
  if (!RELEASE_TAG.test(options.tag)) throw new Error(`invalid release tag: ${options.tag}`);
  if (!REPOSITORY.test(options.repository)) throw new Error(`invalid GitHub repository: ${options.repository}`);

  const targetSha = git(['rev-parse', '--verify', `${options.target}^{commit}`], cwd);
  const previousTag = previousReleaseTag(cwd, options.tag, targetSha);
  const commits = releaseCommits(cwd, previousTag, targetSha);
  const baseUrl = `https://github.com/${options.repository}`;
  const historyUrl = previousTag
    ? `${baseUrl}/compare/${previousTag}...${options.tag}`
    : `${baseUrl}/commits/${options.tag}`;
  const lines = [
    "## What's Changed",
    '',
    ...changelogSections(commits, baseUrl),
    `**Full Changelog**: ${historyUrl}`,
    ''
  ];
  const body = lines.join('\n');

  if (options.output) await Bun.write(options.output, body);
  return { body, commits, previousTag, targetSha };
}

function argument(name: string): string;
function argument(name: string, required: false): string | undefined;
function argument(name: string, required = true): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && !value) throw new Error(`--${name} is required`);
  return value;
}

if (import.meta.main) {
  const result = await generateReleaseChangelog({
    output: argument('output', false),
    repository: argument('repository'),
    tag: argument('tag'),
    target: argument('target')
  });
  process.stdout.write(
    `Generated ${result.commits.length} conventional changelog entries for ${result.previousTag ?? 'repository root'}..${result.targetSha}\n`
  );
}
