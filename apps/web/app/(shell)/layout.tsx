import { Suspense } from 'react';

import { InitGate } from '@/features/init/InitGate';
import { AppShell } from '@/features/shell/AppShell';
import './workplace/projects/[projectId]/workplace.css';

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <InitGate>
        <AppShell />
        {children}
      </InitGate>
    </Suspense>
  );
}
