import type { ChannelsPanelProps } from './types';

import { Badge } from '@monad/ui';

import { useT } from '#/components/I18nProvider';
import { ToggleRow } from './PanelFields';

export function ChannelsPanel(props: ChannelsPanelProps) {
  const t = useT();
  return (
    <div className="space-y-5">
      <div className="divide-y rounded-xl border px-3">
        <ToggleRow
          checked={props.subagentCallable}
          hint={t('web.studio.agentEditor.channels.subagentHint')}
          label={t('web.studio.agentEditor.channels.subagent')}
          onCheckedChange={props.setSubagentCallable}
        />
        <ToggleRow
          checked={props.isPublic}
          hint={t('web.studio.agentEditor.channels.publicHint')}
          label={t('web.studio.agentEditor.channels.public')}
          onCheckedChange={props.setIsPublic}
        />
        <ToggleRow
          checked={props.a2aEnabled}
          hint={t('web.studio.agentEditor.channels.a2aHint')}
          label={t('web.studio.agentEditor.channels.a2a')}
          onCheckedChange={props.setA2aEnabled}
        />
        <ToggleRow
          checked={props.monadixConsume}
          hint={t('web.studio.agentEditor.channels.monadixHint')}
          label={t('web.studio.agentEditor.channels.monadix')}
          onCheckedChange={props.setMonadixConsume}
        />
      </div>
      <div className="flex items-start justify-between gap-3 rounded-xl border bg-muted/20 p-4">
        <div>
          <h3 className="font-medium text-sm">{t('web.studio.agentEditor.channels.status')}</h3>
          <p className="mt-1 break-words text-muted-foreground text-xs">
            {props.a2aStatus?.agentCardUrl ?? t('web.studio.agentEditor.channels.enableHint')}
          </p>
        </div>
        <Badge variant={props.a2aEnabled ? 'secondary' : 'outline'}>
          {t(props.a2aEnabled ? 'web.studio.agentEditor.channels.enabled' : 'web.studio.agentEditor.channels.disabled')}
        </Badge>
      </div>
    </div>
  );
}
