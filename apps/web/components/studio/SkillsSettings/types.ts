import type { SkillContentFile } from '@monad/protocol';

export type Panel = 'installed' | 'browse';
export type SkillEditorState = {
  content: string;
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
