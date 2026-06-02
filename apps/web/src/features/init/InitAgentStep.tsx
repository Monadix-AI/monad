import { CheckIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, Input, Label } from '@monad/ui';

import { useT } from '#/components/I18nProvider';

export function InitAgentStep({
  agentCapabilities,
  agentError,
  agentName,
  agentSaving,
  onBack,
  onSave,
  onSkip,
  savedModelAlias,
  setAgentCapabilities,
  setAgentName
}: {
  agentCapabilities: string;
  agentError: string;
  agentName: string;
  agentSaving: boolean;
  onBack: () => void;
  onSave: () => void;
  onSkip?: () => void;
  savedModelAlias: string;
  setAgentCapabilities: (value: string) => void;
  setAgentName: (value: string) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="agent-name">{t('web.init.agentName')}</Label>
        <Input
          id="agent-name"
          onChange={(event) => setAgentName(event.target.value)}
          placeholder={t('web.init.agentNamePlaceholder')}
          value={agentName}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="agent-capabilities">
          {t('web.init.capabilities')} <span className="text-muted-foreground">{t('web.init.capabilitiesHint')}</span>
        </Label>
        <Input
          id="agent-capabilities"
          onChange={(event) => setAgentCapabilities(event.target.value)}
          placeholder={t('web.init.capabilitiesPlaceholder')}
          value={agentCapabilities}
        />
      </div>
      {savedModelAlias && (
        <p className="text-muted-foreground text-xs">
          {t('web.init.usingProfile')} <span className="font-mono">{savedModelAlias}</span>
        </p>
      )}

      {agentError && (
        <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-xs">
          {agentError}
        </p>
      )}

      <div className="flex items-center justify-between">
        <button
          className="text-muted-foreground text-xs hover:text-foreground"
          onClick={onBack}
          type="button"
        >
          {t('web.init.back')}
        </button>
        <div className="flex items-center gap-2">
          {onSkip ? (
            <Button
              onClick={onSkip}
              size="sm"
              variant="ghost"
            >
              {t('web.init.skipForNow')}
            </Button>
          ) : null}
          <Button
            disabled={!agentName.trim() || agentSaving}
            onClick={onSave}
            size="sm"
          >
            {agentSaving ? (
              <span className="flex items-center gap-2">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                {t('web.init.creating')}
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <HugeiconsIcon
                  className="h-3.5 w-3.5"
                  icon={CheckIcon}
                />
                {t('web.init.complete')}
              </span>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
