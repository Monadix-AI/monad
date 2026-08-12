import type { ProjectController } from '../use-project';

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@monad/ui';
import { workspaceSectionLabelStyle as sectionLabel, uiFontFamily as uiFont } from '@monad/ui/components/AgentAvatar';

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
        className="h-[min(780px,calc(100dvh-1.5rem))] min-w-0"
        showCloseButton
        size="xl"
      >
        <DialogHeader>
          <div style={{ ...sectionLabel, marginBottom: 6 }}>{t('web.workplace.sessionSettingsLabel')}</div>
          <DialogTitle style={{ fontFamily: uiFont, fontSize: 18, fontWeight: 650, lineHeight: 1.25 }}>
            {t('web.workplace.sessionSettingsTitle')}
          </DialogTitle>
          <DialogDescription style={{ marginTop: 5, maxWidth: 600, fontFamily: uiFont, fontSize: 13 }}>
            {t('web.workplace.sessionSettingsDescription')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="scwf-scroll flex flex-col">
          <SessionMembersSection
            activeSessionId={room.activeSessionId}
            availableProjectMembers={room.availableProjectMembers}
            room={room}
            templates={room.projectMembers}
          />
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>{t('web.common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
