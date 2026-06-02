import type { SkillEditorState } from '#/features/studio/skills-settings/types';
import type { SkillsPanelProps } from './types';

import { PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { AddSkillMenu } from '#/features/studio/skills-settings/AddSkillDialog';
import { SkillEditorDialog } from '#/features/studio/skills-settings/SkillEditorDialog';
import { loadSkillContent } from '#/features/studio/skills-settings/utils';
import { isResolvedEmptyList } from '#/lib/async-list-state';
import { useMonadRuntime } from '#/lib/monad-runtime-context';
import { CapabilityCard } from './CapabilityCard';
import { ToggleRow } from './PanelFields';

export function installedSkillAllowlist(
  mode: 'allowlist' | 'inherit',
  current: string[],
  installedIds: string[]
): string[] {
  return mode === 'allowlist' ? [...new Set([...current, ...installedIds])] : current;
}

export function SkillsPanel(props: SkillsPanelProps) {
  const t = useT();
  const { client } = useMonadRuntime();
  const [editor, setEditor] = useState<SkillEditorState | null>(null);

  const setSkill = (id: string, checked: boolean) => {
    props.setSkillsAllow((current) =>
      checked ? [...new Set([...current, id])] : current.filter((candidate) => candidate !== id)
    );
  };

  const editSkill = async (skill: SkillsPanelProps['skills'][number]) => {
    const loaded = await loadSkillContent({ id: skill.id, name: skill.name }, client).catch(() => null);
    if (!loaded) return;
    setEditor({
      id: skill.id,
      name: loaded.name,
      title: skill.name,
      content: loaded.content,
      files: loaded.files
    });
  };

  return (
    <div className="space-y-4">
      <ToggleRow
        checked={props.skillsMode === 'inherit'}
        hint={t('web.studio.agentEditor.skills.workspaceSettingsHint')}
        label={t('web.studio.agentEditor.useWorkspaceSettings')}
        onCheckedChange={(checked) => props.setSkillsMode(checked ? 'inherit' : 'allowlist')}
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">{t('web.studio.agentEditor.skills.flatListHint')}</p>
        <AddSkillMenu
          onInstalled={(result) => {
            if (props.skillsMode === 'allowlist') {
              props.setSkillsAllow((current) => installedSkillAllowlist(props.skillsMode, current, result.ids));
            }
            props.onRefresh();
          }}
          target={{ kind: 'agent', agentId: props.agentId, agentDir: props.agentDir }}
        >
          <Button
            size="sm"
            variant="outline"
          >
            <HugeiconsIcon icon={PlusSignIcon} />
            {t('web.studio.agentEditor.skills.add')}
          </Button>
        </AddSkillMenu>
      </div>
      {isResolvedEmptyList({ isLoading: props.skillsLoading, itemCount: props.skills.length }) ? (
        <p className="rounded-xl border border-dashed p-4 text-muted-foreground text-xs">
          {t('web.studio.agentEditor.skills.empty')}
        </p>
      ) : null}
      <div className="space-y-2">
        {props.skills.map((skill) => (
          <CapabilityCard
            available={skill.available}
            checked={props.skillsMode === 'inherit' || props.skillsAllow.includes(skill.id)}
            detail={skill.detail}
            key={skill.id}
            labels={[
              t(
                skill.sourceKind === 'global'
                  ? 'web.studio.agentEditor.badge.global'
                  : skill.sourceKind === 'atom-pack'
                    ? 'web.studio.agentEditor.badge.atomPack'
                    : 'web.studio.agentEditor.badge.agent'
              )
            ]}
            name={skill.name}
            onCheckedChange={(checked) => setSkill(skill.id, checked)}
            onEdit={
              skill.sourceKind === 'agent'
                ? () => {
                    void editSkill(skill);
                  }
                : undefined
            }
            showSwitch={props.skillsMode === 'allowlist'}
          />
        ))}
      </div>
      <SkillEditorDialog
        editor={editor}
        onClose={() => setEditor(null)}
        onSaved={(skill) => {
          if (props.skillsMode === 'allowlist') setSkill(skill.id, true);
          setEditor(null);
          props.onRefresh();
        }}
      />
    </div>
  );
}
