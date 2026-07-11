import type { MonadPaths } from '@monad/home';
import type { ConfigSnapshot } from '#/config/service.ts';
import type { RuntimeModule } from '#/runtime/types.ts';
import type { SkillStateRef } from '#/store/home/skills.ts';
import type { SkillWatchRegistrar } from './service.ts';

import { resolveSkillState } from '#/store/home/skills.ts';
import { createSkillSubsystem, type SkillSubsystem } from './service.ts';

export interface SkillsLifecycleOptions {
  initial: ConfigSnapshot;
  paths: MonadPaths;
  monadVersion: string;
  watcher: SkillWatchRegistrar;
}

export type StartSkillSubsystem = typeof createSkillSubsystem;

export function createSkillsLifecycleModule(
  options: SkillsLifecycleOptions,
  start: StartSkillSubsystem = createSkillSubsystem
): RuntimeModule<ConfigSnapshot> {
  let current = options.initial;
  let candidate: ConfigSnapshot | undefined;
  const skillState = (skill: SkillStateRef) => {
    const cfg = (candidate ?? current).cfg;
    return resolveSkillState({
      global: cfg.skills,
      agent: cfg.agent.agents.find((agent) => agent.id === cfg.agent.defaultAgentId)?.skills
    })(skill);
  };

  return {
    id: 'capabilities.skills',
    criticality: 'required',
    requires: ['atoms'],
    start: () =>
      start({
        paths: options.paths,
        reloadService: options.watcher,
        monadVersion: options.monadVersion,
        skillState
      }),
    reload: async (output, snapshot) => {
      const subsystem = output as SkillSubsystem;
      candidate = snapshot;
      try {
        await subsystem.reloadSkills();
        current = snapshot;
        return subsystem;
      } finally {
        candidate = undefined;
      }
    }
  };
}
