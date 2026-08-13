import { ObservationMeta } from '@monad/ui';

import { workplaceExperienceT } from '../../../i18n.ts';
import { ObservationToolCardShell, type ObservationToolStatus, ObservationToolStatusIndicator } from './card-shell.tsx';

export type PlanStepView = {
  status: string;
  step: string;
};

export type PlanProgressView = {
  active?: string;
  completed: number;
  steps: readonly PlanStepView[];
  total: number;
};

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function countValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function planProgressView(payload: Record<string, unknown>): PlanProgressView {
  const steps = (Array.isArray(payload.steps) ? payload.steps : []).flatMap((entry): PlanStepView[] => {
    const record =
      entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : undefined;
    const step = textValue(record?.step);
    return step ? [{ status: textValue(record?.status) ?? 'pending', step }] : [];
  });
  const active = textValue(payload.active);
  return {
    ...(active ? { active } : {}),
    completed: countValue(payload.completed),
    steps,
    total: countValue(payload.total) || steps.length
  };
}

function stepStatus(status: string): ObservationToolStatus | undefined {
  if (status === 'completed') return 'success';
  return status === 'inProgress' ? 'running' : undefined;
}

export function PlanProgressCard({
  provider,
  timestamp,
  view
}: {
  provider: string;
  timestamp?: string;
  view: PlanProgressView;
}): React.ReactElement {
  const t = workplaceExperienceT();
  const counts = { completed: view.completed, total: view.total };
  const summary = view.active
    ? t('web.workplace.plan.working', { ...counts, step: view.active })
    : view.completed >= view.total
      ? t('web.workplace.plan.done', counts)
      : t('web.workplace.plan.progress', counts);
  return (
    <ObservationToolCardShell
      defaultOpen
      header={
        <ObservationMeta
          compact
          quiet
          source={provider}
          title={summary}
        />
      }
      kind="tool"
      status={view.completed >= view.total ? 'success' : undefined}
      timestamp={timestamp}
    >
      <ol className="divide-y divide-border/70">
        {view.steps.map((step) => (
          <li
            className="flex min-w-0 items-center gap-2 py-2"
            key={step.step}
          >
            <ObservationToolStatusIndicator status={stepStatus(step.status)} />
            <span
              className={
                step.status === 'completed'
                  ? 'min-w-0 flex-1 font-ui text-muted-foreground text-xs line-through'
                  : 'min-w-0 flex-1 font-ui text-foreground text-xs'
              }
            >
              {step.step}
            </span>
          </li>
        ))}
      </ol>
    </ObservationToolCardShell>
  );
}
