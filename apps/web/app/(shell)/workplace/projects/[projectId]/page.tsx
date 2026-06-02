// Workplace project route. Specific segment so it takes precedence over the [[...slug]]
// catch-all.

import { Workplace } from '@/components/workplace/Workplace';

import './workplace.css';

export function generateStaticParams() {
  return [{ projectId: '__monad_static_export__' }];
}

export default async function WorkplaceProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <Workplace projectId={projectId} />;
}
