import { Suspense } from 'react';

import { AppShell } from '@/components/AppShell';
import { InitGate } from '@/components/InitGate';
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
