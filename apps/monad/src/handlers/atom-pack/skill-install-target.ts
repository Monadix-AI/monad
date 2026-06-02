import type { SkillInstallTarget } from '@monad/protocol';
import type { AtomPacksDeps } from './atom-pack-manager.ts';

import { join } from 'node:path';

import { HandlerError } from '#/handlers/handler-error.ts';
import { toAgentDir } from '#/store/home/agent-def.ts';

export interface ResolvedSkillInstallTarget {
  scopePrefix: `agent:${string}` | 'global';
  skillsDir: string;
  skillsLock: string;
}

export function resolveSkillInstallTarget(
  target: SkillInstallTarget | undefined,
  deps: Pick<AtomPacksDeps, 'config' | 'paths'>
): ResolvedSkillInstallTarget {
  if (!target || target.kind === 'workspace') {
    return { scopePrefix: 'global', skillsDir: deps.paths.skills, skillsLock: deps.paths.skillsLock };
  }

  const agent = deps.config?.get().cfg.agent.agents.find((candidate) => candidate.id === target.agentId);
  if (!agent) throw new HandlerError('not_found', `agent not found: ${target.agentId}`);

  const agentDir = agent.dir ?? toAgentDir(agent.name);
  return {
    scopePrefix: `agent:${agentDir}`,
    skillsDir: join(deps.paths.agents, agentDir, 'skills'),
    skillsLock: join(deps.paths.agents, agentDir, 'skills.lock')
  };
}

export function scopedSkillIds(target: ResolvedSkillInstallTarget, skills: string[]): string[] {
  return skills.map((name) => `${target.scopePrefix}:${name}`);
}
