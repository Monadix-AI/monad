import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSkillSubsystem } from '#/bootstrap/skills.ts';
import { ReloadService } from '#/reload/index.ts';
import { makeTestPaths } from '../../helpers.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'monad-skill-subsystem-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const md = (name: string, body: string): string =>
  ['---', `name: ${name}`, `description: ${name} skill.`, '---', body].join('\n');

async function writeSkill(root: string, name: string, body: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, 'SKILL.md'), md(name, body));
}

test('skill subsystem exposes same-name global, atom-pack, and by-agent skills by addressable id', async () => {
  const paths = makeTestPaths(dir, {
    atoms: join(dir, 'atoms'),
    packs: join(dir, 'atoms', 'packs'),
    skills: join(dir, 'atoms', 'skills'),
    agents: join(dir, 'agents'),
    workspace: join(dir, 'agents', 'default')
  });
  await writeSkill(join(paths.packs, 'monad-test', 'skills'), 'summarize-changes', 'from atom pack');
  await writeSkill(paths.skills, 'summarize-changes', 'from global');
  await writeSkill(join(paths.agents, 'default', 'skills'), 'summarize-changes', 'from default agent');

  const reloadService = new ReloadService({
    log: () => {},
    watchFn: () => ({ close: () => {} })
  });
  const subsystem = await createSkillSubsystem({
    paths,
    reloadService,
    monadVersion: '0.0.0',
    skillState: () => ({ enabled: true, autoload: true })
  });

  expect(subsystem.loadedSkills.map((s) => [s.name, s.body])).toEqual([
    ['atom-pack:monad-test:summarize-changes', 'from atom pack'],
    ['global:summarize-changes', 'from global'],
    ['agent:default:summarize-changes', 'from default agent']
  ]);
  expect(subsystem.skillInstances.map((s) => [s.id, s.sourceKind, s.active])).toEqual([
    ['atom-pack:monad-test:summarize-changes', 'atom-pack', true],
    ['global:summarize-changes', 'global', true],
    ['agent:default:summarize-changes', 'agent', true]
  ]);
  expect(subsystem.skillInstances.map((s) => s.name)).toEqual([
    'summarize-changes',
    'summarize-changes',
    'summarize-changes'
  ]);
});
