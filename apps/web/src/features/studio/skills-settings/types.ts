import type { AgentId, SkillContentFile } from '@monad/protocol';

export type Panel = 'installed' | 'browse';
export type SkillAddTarget = { kind: 'workspace' } | { kind: 'agent'; agentId: AgentId; agentDir: string };
export type SkillInstallResult = { ids: string[]; names: string[] };
export type SkillEditorState = {
  agentDir?: string;
  content: string;
  createTarget?: SkillAddTarget;
  files?: SkillContentFile[];
  id?: string;
  name?: string;
  title?: string;
};
export type SkillAttachmentPreview = {
  content: string;
  contentType?: string;
  file: SkillContentFile;
  preview: 'text' | 'image' | 'unsupported';
};
export type SkillPending = { skills: string[]; warnings: string[] };
export type SkillInstallAttempt =
  | { status: 'consent'; consent: SkillPending }
  | { status: 'failed' }
  | { status: 'installed' };

export function skillMutationTarget(
  target: SkillAddTarget
): { kind: 'workspace' } | { kind: 'agent'; agentId: AgentId } {
  return target.kind === 'agent' ? { kind: 'agent', agentId: target.agentId } : { kind: 'workspace' };
}
