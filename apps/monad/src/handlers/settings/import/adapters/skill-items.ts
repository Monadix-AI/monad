import type { PlannedItem } from '../types.ts';

import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { findSkillDirs, parseSkillMd } from '@/store/home/skills.ts';
import { addItem } from './shared.ts';

export async function addSkillItems(items: PlannedItem[], source: string, dir: string): Promise<void> {
  try {
    if (!(await stat(dir)).isDirectory()) return;
  } catch {
    return;
  }
  let dirs: string[] = [];
  try {
    dirs = await findSkillDirs(dir);
  } catch (err) {
    addItem(items, {
      category: 'skills',
      source,
      target: dir,
      action: 'skip',
      reason: err instanceof Error ? err.message : String(err),
      payload: { kind: 'manual' }
    });
    return;
  }
  for (const skillDir of dirs) {
    try {
      const parsed = parseSkillMd(await Bun.file(join(skillDir, 'SKILL.md')).text());
      addItem(items, {
        category: 'skills',
        source: `${source}:${skillDir}`,
        target: parsed.frontmatter.name,
        action: 'add',
        reason: 'valid SKILL.md can be installed as a global monad skill',
        payload: { kind: 'skill', dir: skillDir, name: parsed.frontmatter.name },
        summary: parsed.frontmatter.description
      });
    } catch (err) {
      addItem(items, {
        category: 'skills',
        source: `${source}:${skillDir}`,
        target: basename(skillDir),
        action: 'skip',
        reason: err instanceof Error ? err.message : String(err),
        payload: { kind: 'manual' }
      });
    }
  }
}
