import type { ModelsPanelProps } from './types';

import { Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@monad/ui';

import { useT } from '#/components/I18nProvider';
import { FieldError } from './PanelFields';

const INHERIT = '__inherit__';
const MODEL_ROLES = [
  { key: 'memory', labelKey: 'web.studio.agentEditor.models.role.memory' },
  { key: 'vision', labelKey: 'web.studio.agentEditor.models.role.vision' },
  { key: 'image', labelKey: 'web.studio.agentEditor.models.role.image' },
  { key: 'speech', labelKey: 'web.studio.agentEditor.models.role.speech' },
  { key: 'embedding', labelKey: 'web.studio.agentEditor.models.role.embedding' }
] as const;

function PanelSection({
  children,
  description,
  title
}: {
  children: React.ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h3 className="shrink-0 font-medium text-muted-foreground text-xs">{title}</h3>
        <div className="h-px flex-1 bg-border/80" />
      </div>
      <p className="text-muted-foreground text-xs">{description}</p>
      {children}
    </section>
  );
}

export function ModelsPanel(props: ModelsPanelProps) {
  const t = useT();
  const updateRole = (key: string, value: string) => {
    props.setRoles((current) => {
      const next = { ...current };
      if (value === INHERIT) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <PanelSection
        description={t('web.studio.agentEditor.models.routingDescription')}
        title={t('web.studio.agentEditor.models.routing')}
      >
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="grid min-h-12 grid-cols-[minmax(0,1fr)_minmax(190px,56%)] items-center gap-4 px-3 py-2 max-[520px]:grid-cols-1 max-[520px]:gap-1.5">
            <Label htmlFor="flow-agent-model">{t('web.studio.agentEditor.models.profile')}</Label>
            <Select
              onValueChange={(value) => props.setModel(value === INHERIT ? '' : value)}
              value={props.model || INHERIT}
            >
              <SelectTrigger
                aria-label={t('web.studio.agentEditor.models.profile')}
                className="w-full bg-background"
                id="flow-agent-model"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>{t('web.studio.agentEditor.models.workspaceDefault')}</SelectItem>
                {props.profiles.map((profile) => (
                  <SelectItem
                    key={profile.alias}
                    value={profile.alias}
                  >
                    {profile.alias}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <h4 className="shrink-0 font-medium text-muted-foreground text-xs">
            {t('web.studio.agentEditor.models.roleOverrides')}
          </h4>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <div className="overflow-hidden rounded-xl border bg-card">
          {MODEL_ROLES.map(({ key, labelKey }) => (
            <div
              className="grid min-h-12 grid-cols-[minmax(0,1fr)_minmax(190px,56%)] items-center gap-4 border-t px-3 py-2 transition-colors first:border-t-0 hover:bg-muted/20 max-[520px]:grid-cols-1 max-[520px]:gap-1.5"
              key={key}
            >
              <Label>{t(labelKey)}</Label>
              <Select
                onValueChange={(value) => updateRole(key, value)}
                value={props.roles[key] ?? INHERIT}
              >
                <SelectTrigger className="w-full bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT}>{t('web.studio.agentEditor.models.inheritProfile')}</SelectItem>
                  {props.profiles.map((profile) => (
                    <SelectItem
                      key={profile.alias}
                      value={profile.alias}
                    >
                      {profile.alias}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      </PanelSection>

      <PanelSection
        description={t('web.studio.agentEditor.models.executionLimitsDescription')}
        title={t('web.studio.agentEditor.models.executionLimits')}
      >
        <div className="grid grid-cols-3 overflow-hidden rounded-xl border bg-card max-[520px]:grid-cols-1">
          <div className="space-y-1.5 p-3">
            <Label htmlFor="flow-max-turns">{t('web.studio.agentEditor.models.maxTurns')}</Label>
            <Input
              className="bg-background"
              id="flow-max-turns"
              inputMode="numeric"
              onChange={(event) => props.setMaxTurns(event.target.value)}
              placeholder={t('web.studio.agentEditor.models.noLimit')}
              value={props.maxTurns}
            />
            <FieldError>{props.errors.maxTurns}</FieldError>
          </div>
          <div className="space-y-1.5 border-l p-3 max-[520px]:border-t max-[520px]:border-l-0">
            <Label htmlFor="flow-max-thinking">{t('web.studio.agentEditor.models.tokenBudget')}</Label>
            <Input
              className="bg-background"
              id="flow-max-thinking"
              inputMode="numeric"
              onChange={(event) => props.setMaxThinkingTokens(event.target.value)}
              placeholder={t('web.studio.agentEditor.models.noLimit')}
              value={props.maxThinkingTokens}
            />
            <FieldError>{props.errors.maxThinkingTokens}</FieldError>
          </div>
          <div className="space-y-1.5 border-l p-3 max-[520px]:border-t max-[520px]:border-l-0">
            <Label htmlFor="flow-max-budget">{t('web.studio.agentEditor.models.costLimit')}</Label>
            <Input
              className="bg-background"
              id="flow-max-budget"
              inputMode="decimal"
              onChange={(event) => props.setMaxBudgetUsd(event.target.value)}
              placeholder={t('web.studio.agentEditor.models.noLimit')}
              value={props.maxBudgetUsd}
            />
            <FieldError>{props.errors.maxBudgetUsd}</FieldError>
          </div>
        </div>
      </PanelSection>
    </div>
  );
}
