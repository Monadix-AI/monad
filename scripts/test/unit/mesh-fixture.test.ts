import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', '..', 'mesh-fixture.ts');
const MESH_ID = 'mesh_A1b2C3d4E5f6';
const OTHER_MESH_ID = 'mesh_Z9y8X7w6V5u4';

const directories: string[] = [];

interface MutableManifest {
  turns: Array<{ startRecord: number; endRecordExclusive: number; nextCursor?: string }>;
}

function turnAt(manifest: MutableManifest, index: number): MutableManifest['turns'][number] {
  const turn = manifest.turns[index];
  if (!turn) throw new Error(`expected manifest turn ${index}`);
  return turn;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'monad-multi-turn-fixture-'));
  directories.push(directory);
  return directory;
}

async function run(...args: string[]) {
  const process = Bun.spawn(['bun', SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited
  ]);
  return { stdout, stderr, exitCode };
}

function codexTurn(index: number, sharedId = 'call_shared000001') {
  return [
    { type: 'session_meta', payload: { id: 'thread_shared0001', cwd: `/private/project-${index}` } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: `turn_${index}000000` } },
    {
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: sharedId, name: 'exec', arguments: `secret command ${index}` }
    },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: `turn_${index}000000` } }
  ];
}

function claudeTurn(index: number) {
  return [
    { type: 'user', session_id: 'claude_shared0001', message: { role: 'user', content: `request ${index}` } },
    { type: 'result', session_id: 'claude_shared0001', subtype: 'success', result: `response ${index}` }
  ];
}

function jsonl(records: readonly unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function writeCapture(path: string, records: readonly unknown[], modifiedSeconds: number) {
  const text = jsonl(records);
  await Bun.write(path, text);
  await utimes(path, modifiedSeconds, modifiedSeconds);
  return text;
}

async function inspect(args: { directory: string; sources: string[]; provider?: 'codex' | 'claude-code' }) {
  const manifest = join(args.directory, 'reviewed-boundaries.json');
  const result = await run('inspect', '--provider', args.provider ?? 'codex', '--manifest', manifest, ...args.sources);
  return { ...result, manifest, value: await Bun.file(manifest).json() };
}

async function writeManifest(
  path: string,
  provider: string,
  sources: Array<{ path: string; text: string }>,
  turns: Array<{ startRecord: number; endRecordExclusive: number }>
) {
  await Bun.write(
    path,
    `${JSON.stringify(
      {
        version: 1,
        provider,
        sources: sources.map((source) => ({
          basename: basename(source.path),
          bytes: Buffer.byteLength(source.text),
          sha256: sha256(source.text)
        })),
        turns
      },
      null,
      2
    )}\n`
  );
}

test('inspect orders explicit captures by mtime and binds their exact bytes and hashes', async () => {
  const directory = await workDir();
  const newer = join(directory, `codex-${MESH_ID}-oep_newer.jsonl`);
  const older = join(directory, `codex-${MESH_ID}-oep_older.jsonl`);
  const olderText = await writeCapture(older, [...codexTurn(0), ...codexTurn(1)], 1_700_000_000);
  const newerText = await writeCapture(newer, [...codexTurn(2), ...codexTurn(3)], 1_700_000_100);

  const inspected = await inspect({ directory, sources: [newer, older] });

  expect({
    exitCode: inspected.exitCode,
    manifest: inspected.value,
    stdoutSafe: !inspected.stdout.includes(directory),
    stderr: inspected.stderr
  }).toEqual({
    exitCode: 0,
    manifest: {
      version: 1,
      provider: 'codex',
      sources: [
        { basename: basename(older), bytes: Buffer.byteLength(olderText), sha256: sha256(olderText) },
        { basename: basename(newer), bytes: Buffer.byteLength(newerText), sha256: sha256(newerText) }
      ],
      turns: [
        { startRecord: 0, endRecordExclusive: 4 },
        { startRecord: 4, endRecordExclusive: 8 },
        { startRecord: 8, endRecordExclusive: 12 },
        { startRecord: 12, endRecordExclusive: 16 }
      ]
    },
    stdoutSafe: true,
    stderr: ''
  });
});

test('build preserves reviewed record order and one sanitizer identity across turn pages', async () => {
  const directory = await workDir();
  const first = join(directory, `codex-${MESH_ID}-oep_first.jsonl`);
  const second = join(directory, `codex-${MESH_ID}-oep_second.jsonl`);
  await writeCapture(first, [...codexTurn(0), ...codexTurn(1)], 1_700_000_000);
  await writeCapture(second, [...codexTurn(2), ...codexTurn(3)], 1_700_000_100);
  const inspected = await inspect({ directory, sources: [second, first] });
  const output = join(directory, 'codex-multi-turn.raw.json');

  const built = await run('build', '--manifest', inspected.manifest, '--output', output, second, first);
  const fixture = await Bun.file(output).json();
  const flattened = fixture.turns.flatMap((turn: { records: Array<{ data: unknown }> }) =>
    turn.records.map((record) => record.data)
  );
  const sharedIds = flattened
    .flatMap((record: { payload?: { call_id?: string } }) => record.payload?.call_id ?? [])
    .filter(Boolean);

  expect({
    exitCode: built.exitCode,
    stderr: built.stderr,
    stdoutSafe: !built.stdout.includes(directory),
    provider: fixture.provider,
    pages: fixture.turns.map((turn: { coverage: string; records: unknown[]; nextCursor?: string }) => ({
      coverage: turn.coverage,
      records: turn.records.length,
      nextCursor: turn.nextCursor ?? null
    })),
    order: flattened.map((record: { type?: string; payload?: { type?: string } }) =>
      record.type === 'event_msg' ? record.payload?.type : record.type
    ),
    sharedIds,
    bytesWithinLimit: (await Bun.file(output).size) <= 1_048_576
  }).toEqual({
    exitCode: 0,
    stderr: '',
    stdoutSafe: true,
    provider: 'codex',
    pages: Array.from({ length: 4 }, () => ({ coverage: 'settled', records: 4, nextCursor: null })),
    order: Array.from({ length: 4 }, () => ['session_meta', 'task_started', 'response_item', 'task_complete']).flat(),
    sharedIds: ['<id:3>', '<id:3>', '<id:3>', '<id:3>'],
    bytesWithinLimit: true
  });
});

test('build rejects changed sources, overlapping spans, out-of-bounds spans, incomplete ends, and nextCursor', async () => {
  const directory = await workDir();
  const source = join(directory, `codex-${MESH_ID}-oep_only.jsonl`);
  await writeCapture(source, [...codexTurn(0), ...codexTurn(1), ...codexTurn(2), ...codexTurn(3)], 1_700_000_000);
  const inspected = await inspect({ directory, sources: [source] });

  const cases: Array<{ name: string; mutate: (manifest: MutableManifest) => void; expected: string }> = [
    {
      name: 'overlap',
      mutate: (manifest) => {
        turnAt(manifest, 1).startRecord = 3;
      },
      expected: 'overlap'
    },
    {
      name: 'out-of-bounds',
      mutate: (manifest) => {
        turnAt(manifest, 3).endRecordExclusive = 99;
      },
      expected: 'out of bounds'
    },
    {
      name: 'incomplete',
      mutate: (manifest) => {
        turnAt(manifest, 3).endRecordExclusive = 15;
      },
      expected: 'native complete-turn endpoint'
    },
    {
      name: 'next-cursor',
      mutate: (manifest) => {
        turnAt(manifest, 0).nextCursor = 'provider:older';
      },
      expected: 'invalid manifest'
    }
  ];
  const outcomes = [];
  for (const entry of cases) {
    const manifest = structuredClone(inspected.value) as MutableManifest;
    entry.mutate(manifest);
    const manifestPath = join(directory, `${entry.name}.json`);
    const output = join(directory, `${entry.name}.raw.json`);
    await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = await run('build', '--manifest', manifestPath, '--output', output, source);
    outcomes.push({
      name: entry.name,
      exitCode: result.exitCode,
      expectedError: result.stderr.includes(entry.expected),
      stderrSafe: !result.stderr.includes(directory),
      wrote: await Bun.file(output).exists()
    });
  }

  await Bun.write(source, `${await Bun.file(source).text()}${JSON.stringify({ type: 'event_msg' })}\n`);
  const changedOutput = join(directory, 'changed.raw.json');
  const changed = await run('build', '--manifest', inspected.manifest, '--output', changedOutput, source);
  outcomes.push({
    name: 'changed',
    exitCode: changed.exitCode,
    expectedError: changed.stderr.includes('source binding mismatch'),
    stderrSafe: !changed.stderr.includes(directory),
    wrote: await Bun.file(changedOutput).exists()
  });

  expect(outcomes).toEqual([
    { name: 'overlap', exitCode: 2, expectedError: true, stderrSafe: true, wrote: false },
    { name: 'out-of-bounds', exitCode: 2, expectedError: true, stderrSafe: true, wrote: false },
    { name: 'incomplete', exitCode: 2, expectedError: true, stderrSafe: true, wrote: false },
    { name: 'next-cursor', exitCode: 2, expectedError: true, stderrSafe: true, wrote: false },
    { name: 'changed', exitCode: 2, expectedError: true, stderrSafe: true, wrote: false }
  ]);
}, 15_000);

test('build rejects mixed provider capture names and mixed mesh session capture names', async () => {
  const directory = await workDir();
  const codex = join(directory, `codex-${MESH_ID}-oep_codex.jsonl`);
  const claude = join(directory, `claude-code-${MESH_ID}-oep_claude.jsonl`);
  const otherMesh = join(directory, `codex-${OTHER_MESH_ID}-oep_other.jsonl`);
  const codexText = await writeCapture(codex, codexTurn(0), 1_700_000_000);
  const claudeText = await writeCapture(claude, claudeTurn(0), 1_700_000_100);
  const otherMeshText = await writeCapture(otherMesh, codexTurn(1), 1_700_000_100);
  const spans = [{ startRecord: 0, endRecordExclusive: 4 }];
  const providerManifest = join(directory, 'mixed-provider.json');
  const meshManifest = join(directory, 'mixed-mesh.json');
  await writeManifest(
    providerManifest,
    'codex',
    [
      { path: codex, text: codexText },
      { path: claude, text: claudeText }
    ],
    spans
  );
  await writeManifest(
    meshManifest,
    'codex',
    [
      { path: codex, text: codexText },
      { path: otherMesh, text: otherMeshText }
    ],
    spans
  );

  const providerResult = await run(
    'build',
    '--manifest',
    providerManifest,
    '--output',
    join(directory, 'provider.raw.json'),
    codex,
    claude
  );
  const meshResult = await run(
    'build',
    '--manifest',
    meshManifest,
    '--output',
    join(directory, 'mesh.raw.json'),
    codex,
    otherMesh
  );

  expect([
    {
      exitCode: providerResult.exitCode,
      expectedError: providerResult.stderr.includes('mixed providers'),
      stderrSafe: !providerResult.stderr.includes(directory)
    },
    {
      exitCode: meshResult.exitCode,
      expectedError: meshResult.stderr.includes('mixed mesh session IDs'),
      stderrSafe: !meshResult.stderr.includes(directory)
    }
  ]).toEqual([
    { exitCode: 2, expectedError: true, stderrSafe: true },
    { exitCode: 2, expectedError: true, stderrSafe: true }
  ]);
});

test('inspect rejects all-noncanonical capture names without writing a manifest', async () => {
  const directory = await workDir();
  const first = join(directory, 'capture-a.jsonl');
  const second = join(directory, 'capture-b.jsonl');
  const manifest = join(directory, 'renamed-inspection.json');
  await writeCapture(first, [...codexTurn(0), ...codexTurn(1)], 1_700_000_000);
  await writeCapture(second, [...codexTurn(2), ...codexTurn(3)], 1_700_000_100);

  const result = await run('inspect', '--provider', 'codex', '--manifest', manifest, first, second);

  expect({
    exitCode: result.exitCode,
    expectedError: result.stderr.includes('canonical MeshFixtureTap capture name'),
    stderrSafe: !result.stderr.includes(directory),
    wrote: await Bun.file(manifest).exists()
  }).toEqual({ exitCode: 2, expectedError: true, stderrSafe: true, wrote: false });
});

test('build rejects renamed mixed-provider sources without writing fixture output', async () => {
  const directory = await workDir();
  const codex = join(directory, 'renamed-a.jsonl');
  const claude = join(directory, 'renamed-b.jsonl');
  const codexText = await writeCapture(codex, [...codexTurn(0), ...codexTurn(1)], 1_700_000_000);
  const claudeText = await writeCapture(claude, [...claudeTurn(2), ...claudeTurn(3)], 1_700_000_100);
  const manifest = join(directory, 'renamed-mixed.json');
  await writeManifest(
    manifest,
    'codex',
    [
      { path: codex, text: codexText },
      { path: claude, text: claudeText }
    ],
    [
      { startRecord: 0, endRecordExclusive: 4 },
      { startRecord: 4, endRecordExclusive: 8 },
      { startRecord: 8, endRecordExclusive: 10 },
      { startRecord: 10, endRecordExclusive: 12 }
    ]
  );
  const output = join(directory, 'renamed-mixed.raw.json');

  const result = await run('build', '--manifest', manifest, '--output', output, codex, claude);

  expect({
    exitCode: result.exitCode,
    expectedError: result.stderr.includes('canonical MeshFixtureTap capture name'),
    stderrSafe: !result.stderr.includes(directory),
    wrote: await Bun.file(output).exists()
  }).toEqual({ exitCode: 2, expectedError: true, stderrSafe: true, wrote: false });
});

test('build refuses a formatted fixture larger than one MiB', async () => {
  const directory = await workDir();
  const source = join(directory, `codex-${MESH_ID}-oep_large.jsonl`);
  const records = Array.from({ length: 4 }, (_, index) => ({
    type: 'event_msg',
    payload: { type: 'task_complete', [`padding_${index}_${'x'.repeat(270_000)}`]: index }
  }));
  const text = await writeCapture(source, records, 1_700_000_000);
  const manifest = join(directory, 'large.json');
  await writeManifest(
    manifest,
    'codex',
    [{ path: source, text }],
    records.map((_, index) => ({ startRecord: index, endRecordExclusive: index + 1 }))
  );
  const output = join(directory, 'too-large.raw.json');

  const result = await run('build', '--manifest', manifest, '--output', output, source);

  expect({
    exitCode: result.exitCode,
    expectedError: result.stderr.includes('1 MiB'),
    stderrSafe: !result.stderr.includes(directory),
    wrote: await Bun.file(output).exists()
  }).toEqual({ exitCode: 2, expectedError: true, stderrSafe: true, wrote: false });
});
