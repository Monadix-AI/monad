import type { ReactNode } from 'react';

import { Activity } from 'react';

export function SessionUiActivity({
  children,
  visible
}: {
  children: ReactNode;
  visible: boolean;
}): React.ReactElement {
  return <Activity mode={visible ? 'visible' : 'hidden'}>{children}</Activity>;
}
