import type { ShellCardView } from '@monad/ui';
import type { ObservationItem } from './types.ts';

import { ShellCardHeader } from '@monad/ui';

import { workplaceExperienceT } from '../../../i18n.ts';
import { commandToolView } from './command-card.tsx';

export { ShellCard as ShellToolCard } from '@monad/ui';

export function ShellToolHeader({ view }: { view: ShellCardView }) {
  const t = workplaceExperienceT();
  const headerView = view.provider === 'codex' ? { ...view, title: t('web.tools.shell') } : view;
  return (
    <ShellCardHeader
      labels={{
        completed: t('web.plan.statusCompleted'),
        exitCode: (code) => t('web.workplace.shell.exitCode', { code }),
        running: t('web.plan.statusInProgress'),
        toolCall: t('web.workplace.shell.toolCall')
      }}
      view={headerView}
    />
  );
}

export function shellToolView(
  call: ObservationItem,
  result: ObservationItem | undefined,
  provider: string
): ShellCardView | null {
  if (call.tool?.category !== 'shell') return null;
  const view = commandToolView(call, result ?? call, provider);
  if (!view?.command) return null;
  const title = claudeShellTitle(call, provider);
  return {
    command: view.command,
    provider: view.provider,
    type: view.type,
    ...(title ? { title } : {}),
    ...(view.cwd === undefined ? {} : { cwd: view.cwd }),
    ...(view.durationMs === undefined ? {} : { durationMs: view.durationMs }),
    ...(view.exitCode === undefined ? {} : { exitCode: view.exitCode }),
    ...(view.output === undefined ? {} : { output: view.output }),
    ...(view.status === undefined ? {} : { status: view.status })
  };
}

function claudeShellTitle(call: ObservationItem, provider: string): string | undefined {
  if (provider !== 'claude-code' || call.tool?.name.toLowerCase() !== 'bash') return undefined;
  const input = call.tool.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const description = (input as Record<string, unknown>).description;
  return typeof description === 'string' ? description.trim() || undefined : undefined;
}
