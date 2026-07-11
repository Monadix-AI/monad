import type { MonadPaths } from '@monad/home';
import type { PrincipalId } from '@monad/protocol';
import type { SkillSubsystem } from '#/capabilities/skills/service.ts';
import type { ConfigSnapshot } from '#/config/service.ts';

import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/home';

import { createSkillsLifecycleModule } from '#/capabilities/skills/lifecycle.ts';
import { RuntimeContext } from '#/runtime/context.ts';

test('reloads stable skill views from the latest config snapshot', async () => {
  const cfg = createDefaultConfig('usr_test' as PrincipalId, 'Test');
  const initial: ConfigSnapshot = { cfg, auth: null };
  const next: ConfigSnapshot = {
    auth: null,
    cfg: { ...cfg, skills: { ...cfg.skills, disabled: ['skill:test'] } }
  };
  const states: Array<{ autoload: boolean; enabled: boolean }> = [];
  let resolveState: ((skill: { id: string; name: string }) => { autoload: boolean; enabled: boolean }) | undefined;
  const subsystem = {
    loadedSkills: [],
    skillList: [],
    skillInstances: [],
    skillCollisions: [],
    discoverProjectSkills: async () => [],
    reloadSkills: async () => {
      if (resolveState) states.push(resolveState({ id: 'skill:test', name: 'test' }));
    }
  } satisfies SkillSubsystem;
  const module = createSkillsLifecycleModule(
    {
      initial,
      paths: {} as MonadPaths,
      monadVersion: '1.0.0',
      watcher: { register: () => true }
    },
    async (options) => {
      resolveState = options.skillState;
      states.push(options.skillState({ id: 'skill:test', name: 'test' }));
      return subsystem;
    }
  );
  const context = new RuntimeContext();
  context.commit('atoms', {});

  const started = await module.start(context, new AbortController().signal);
  const reloaded = await module.reload?.(started, next, context, new AbortController().signal);

  expect({
    criticality: module.criticality,
    id: module.id,
    output: reloaded,
    requires: module.requires,
    states
  }).toEqual({
    criticality: 'required',
    id: 'capabilities.skills',
    output: subsystem,
    requires: ['atoms'],
    states: [
      { autoload: cfg.skills.autoload, enabled: true },
      { autoload: false, enabled: false }
    ]
  });
});

test('retains the accepted skill state when reload fails', async () => {
  const cfg = createDefaultConfig('usr_test' as PrincipalId, 'Test');
  const initial: ConfigSnapshot = { cfg, auth: null };
  const next: ConfigSnapshot = {
    auth: null,
    cfg: { ...cfg, skills: { ...cfg.skills, disabled: ['skill:test'] } }
  };
  let resolveState = (_skill: { id: string; name: string }) => ({ autoload: false, enabled: false });
  const subsystem = {
    loadedSkills: [],
    skillList: [],
    skillInstances: [],
    skillCollisions: [],
    discoverProjectSkills: async () => [],
    reloadSkills: async () => {
      throw new Error('skill reload failed');
    }
  } satisfies SkillSubsystem;
  const module = createSkillsLifecycleModule(
    {
      initial,
      paths: {} as MonadPaths,
      monadVersion: '1.0.0',
      watcher: { register: () => true }
    },
    async (options) => {
      resolveState = options.skillState;
      return subsystem;
    }
  );
  const context = new RuntimeContext();
  context.commit('atoms', {});
  const started = await module.start(context, new AbortController().signal);

  await expect(module.reload?.(started, next, context, new AbortController().signal)).rejects.toThrow(
    'skill reload failed'
  );

  expect(resolveState({ id: 'skill:test', name: 'test' })).toEqual({
    autoload: cfg.skills.autoload,
    enabled: true
  });
});
