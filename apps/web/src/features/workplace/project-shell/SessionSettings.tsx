import type { ProjectController } from '../use-project';

import { Dialog, DialogContent, DialogTitle } from '@monad/ui';
import { workspaceSans as sans, workspaceSectionLabelStyle as sectionLabel } from '@monad/ui/components/AgentAvatar';

import { useT } from '#/components/I18nProvider';
import { SessionMembersSection } from './SessionMembersSection';

export function SessionSettings({
  onClose,
  room
}: {
  onClose: () => void;
  room: ProjectController;
}): React.ReactElement {
  const t = useT();
  return (
    <Dialog
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent
        className="flex h-[min(780px,calc(100vh-1.5rem))] min-w-0 max-w-3xl flex-col overflow-hidden p-0 sm:max-w-3xl"
        showCloseButton
      >
        <div style={{ borderBottom: `1px solid ${'var(--border)'}`, padding: '16px 18px 14px' }}>
          <div style={{ ...sectionLabel, marginBottom: 6 }}>{t('web.workplace.sessionSettingsLabel')}</div>
          <DialogTitle style={{ fontFamily: sans, fontSize: 18, fontWeight: 650, lineHeight: 1.25 }}>
            {t('web.workplace.sessionSettingsTitle')}
          </DialogTitle>
          <p style={{ marginTop: 5, maxWidth: 600, fontFamily: sans, fontSize: 13, color: 'var(--muted-foreground)' }}>
            {t('web.workplace.sessionSettingsDescription')}
          </p>
        </div>
        <div className="scwf-scroll flex min-h-0 flex-1 flex-col overflow-y-auto p-[18px]">
          <SessionMembersSection
            activeSessionId={room.activeSessionId}
            availableProjectMembers={room.availableProjectMembers}
            room={room}
            templates={room.projectMembers}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
