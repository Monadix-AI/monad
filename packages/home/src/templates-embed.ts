/// <reference path="./templates.d.ts" />
// Static `with { type: 'file' }` imports so `bun build --compile` embeds the starter
// templates into the binary. A runtime `join(import.meta.dir, 'templates')` path is NOT
// seen by the compiler, so those files would be missing from $bunfs and init/daemon would
// crash with ENOENT on first run (works only in dev, where the path is a real one).
import agentMd from './templates/AGENT.md' with { type: 'file' };
import modelProviderSampleMd from './templates/model-provider.sample.md' with { type: 'file' };
import soulMd from './templates/SOUL.md' with { type: 'file' };
import summarizeChangesMd from './templates/skills/summarize-changes.md' with { type: 'file' };
import userMd from './templates/USER.md' with { type: 'file' };

/** Logical template name → its file path (real in dev, embedded $bunfs in the binary). */
export const TEMPLATES = {
  'AGENT.md': agentMd,
  'SOUL.md': soulMd,
  'USER.md': userMd,
  'model-provider.sample.md': modelProviderSampleMd,
  'skills/summarize-changes.md': summarizeChangesMd
} as const;

export type TemplateName = keyof typeof TEMPLATES;
