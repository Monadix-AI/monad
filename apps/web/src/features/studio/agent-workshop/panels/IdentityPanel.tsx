import type { IdentityPanelProps } from './types';

import { Button, cn, Input, Label, Textarea } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { appendPromptGuidance } from '../agent-flow-model';
import { FieldError } from './PanelFields';

const FILES = ['agent', 'user'] as const;
const GUIDANCE = ['Be concise.', 'Ask before risky actions.', 'Explain important decisions.'];

export function IdentityPanel(props: IdentityPanelProps) {
  const t = useT();
  const [activeFile, setActiveFile] = useState<(typeof FILES)[number]>('agent');
  const filename = activeFile === 'agent' ? 'AGENT.md' : 'USER.md';
  const updateFile = (value: string) => props.setInstructions({ ...props.instructions, [activeFile]: value });

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="flow-agent-name">{t('web.studio.agentEditor.identity.name')}</Label>
        <Input
          autoComplete="off"
          id="flow-agent-name"
          name="agent-name"
          onChange={(event) => props.setName(event.target.value)}
          value={props.name}
        />
        <FieldError>{props.errors.name}</FieldError>
      </div>
      <div className="space-y-2">
        <div>
          <Label>{t('web.studio.agentEditor.identity.files')}</Label>
          <p className="mt-1 text-muted-foreground text-xs">{t('web.studio.agentEditor.identity.filesHint')}</p>
        </div>
        <div
          aria-label={t('web.studio.agentEditor.identity.files')}
          className="flex gap-1 border-b"
          role="tablist"
        >
          {FILES.map((file) => (
            <button
              aria-controls={`instruction-panel-${file}`}
              aria-selected={activeFile === file}
              className={cn(
                'min-h-9 border-transparent border-b-2 px-3 font-mono text-xs',
                activeFile === file ? 'border-foreground text-foreground' : 'text-muted-foreground'
              )}
              key={file}
              onClick={() => setActiveFile(file)}
              role="tab"
              type="button"
            >
              {file === 'agent' ? 'AGENT.md' : 'USER.md'}
            </button>
          ))}
        </div>
        <div
          id={`instruction-panel-${activeFile}`}
          role="tabpanel"
        >
          <Textarea
            aria-label={filename}
            className="min-h-52 resize-y font-mono text-sm leading-relaxed"
            name={`instruction-${activeFile}`}
            onChange={(event) => updateFile(event.target.value)}
            placeholder={t(`web.studio.agentEditor.identity.${activeFile}Placeholder`)}
            value={props.instructions[activeFile]}
          />
        </div>
      </div>
      {activeFile === 'agent' ? (
        <div className="flex flex-wrap gap-2">
          {GUIDANCE.map((guidance) => (
            <Button
              key={guidance}
              onClick={() => updateFile(appendPromptGuidance(props.instructions.agent, guidance))}
              size="sm"
              type="button"
              variant="outline"
            >
              {guidance.replace(/\.$/, '')}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
