import type { ReactElement } from 'react';
import type { SkillAddTarget, SkillInstallResult } from './types';

import { PencilEdit01Icon, Upload01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useUploadSkillMutation } from '@monad/client-rtk';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@monad/ui';
import { useRef, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { toast } from '#/components/ToastProvider';
import { GitHubMark } from './GitHubMark';
import { GithubInstallDialog } from './GithubInstallDialog';
import { SkillEditorDialog } from './SkillEditorDialog';
import { UploadSkillDialog } from './UploadSkillDialog';

export const ADD_SKILL_SOURCES = ['github', 'upload', 'create'] as const;
export type AddSkillSource = (typeof ADD_SKILL_SOURCES)[number];

const NEW_SKILL = `---
name: new-skill
description: Describe when this skill should be used.
---

# New Skill

Add reusable instructions here.
`;

export function AddSkillMenuItems({
  onSelect,
  translate
}: {
  onSelect: (source: AddSkillSource) => void;
  translate: (key: string) => string;
}) {
  return [
    {
      id: 'github' as const,
      icon: <GitHubMark className="size-4" />,
      label: translate('web.skills.addGithub')
    },
    {
      id: 'upload' as const,
      icon: (
        <HugeiconsIcon
          className="size-4"
          icon={Upload01Icon}
        />
      ),
      label: translate('web.skills.addUpload')
    },
    {
      id: 'create' as const,
      icon: (
        <HugeiconsIcon
          className="size-4"
          icon={PencilEdit01Icon}
        />
      ),
      label: translate('web.skills.addEditor')
    }
  ].map((source) => (
    <DropdownMenuItem
      data-skill-source={source.id}
      key={source.id}
      onSelect={() => onSelect(source.id)}
    >
      {source.icon}
      {source.label}
    </DropdownMenuItem>
  ));
}

export function AddSkillMenu({
  children,
  onInstalled,
  target
}: {
  children: ReactElement;
  onInstalled: (result: SkillInstallResult) => Promise<void> | void;
  target: SkillAddTarget;
}) {
  const t = useT();
  const [source, setSource] = useState<AddSkillSource | null>(null);
  const [uploadSkill, { isLoading: uploading }] = useUploadSkillMutation();
  const inputRef = useRef<HTMLInputElement>(null);

  const complete = async (result: SkillInstallResult) => {
    await onInstalled(result);
    setSource(null);
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    const result = await uploadSkill({
      filename: file.name,
      body: file,
      contentType: file.type || 'application/octet-stream',
      overwrite: true,
      target: target.kind === 'agent' ? { kind: 'agent', agentId: target.agentId } : { kind: 'workspace' }
    })
      .unwrap()
      .catch(() => null);
    if (!result) {
      toast.error(t('web.skills.uploadFailed'));
      return;
    }
    await complete({ ids: result.skillIds ?? [], names: result.skills });
  };

  if (source === 'github') {
    return (
      <GithubInstallDialog
        onCancel={() => setSource(null)}
        onInstalled={complete}
        target={target}
      />
    );
  }

  if (source === 'upload') {
    return (
      <>
        <input
          accept=".md,.zip,.skill,text/markdown,application/zip"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = '';
            void upload(file);
          }}
          ref={inputRef}
          type="file"
        />
        <UploadSkillDialog
          inputRef={inputRef}
          loading={uploading}
          onClose={() => setSource(null)}
          onFile={(file) => void upload(file)}
          open
        />
      </>
    );
  }

  if (source === 'create') {
    return (
      <SkillEditorDialog
        editor={{ content: NEW_SKILL, createTarget: target }}
        onClose={() => setSource(null)}
        onSaved={(skill) => void complete({ ids: [skill.id], names: [skill.name] })}
      />
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <AddSkillMenuItems
          onSelect={setSource}
          translate={t}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
