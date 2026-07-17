import type { UIApprovalDisplay } from '@monad/protocol';

import { ApprovalResourceCard } from '@monad/ui';

import { useT } from '#/components/I18nProvider';

export function ApprovalDisplayCard({ display }: { display?: UIApprovalDisplay }) {
  const t = useT();
  if (display?.kind !== 'resource-approval') return null;
  return (
    <ApprovalResourceCard
      defaultScope={display.defaultScope}
      defaultScopeLabel={t('web.chat.resourceDefaultScope')}
      operation={display.operation}
      resourceLabel={
        display.resource === 'network' ? t('web.chat.resourceNetworkAccess') : t('web.chat.resourceFileAccess')
      }
      subject={display.subject}
    />
  );
}
