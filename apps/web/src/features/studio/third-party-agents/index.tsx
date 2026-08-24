import type { StudioSectionProps } from '#/features/studio/section-registry';

import { useT } from '#/components/I18nProvider';
import { PanelShell, PanelShellBody } from '#/components/ui/panel-shell';
import { StudioBreadcrumbHeader } from '#/features/studio/StudioBreadcrumbHeader';
import { AcpAgentsSettings } from './AcpAgentsSettings';

export function ThirdPartyAgentsSettings({ onClose }: StudioSectionProps) {
  const t = useT();

  return (
    <PanelShell>
      <StudioBreadcrumbHeader title={t('web.studio.acpDelegates')} />
      <div className="border-b bg-muted/20 px-5 py-3">
        <p className="max-w-[72ch] text-muted-foreground text-sm">{t('web.studio.acpDelegatesDesc')}</p>
      </div>
      <PanelShellBody>
        <div className="mx-auto w-full max-w-5xl p-4 lg:p-5">
          <section className="overflow-hidden rounded-xl border bg-card">
            <AcpAgentsSettings
              embedded
              onClose={onClose}
            />
          </section>
        </div>
      </PanelShellBody>
    </PanelShell>
  );
}
