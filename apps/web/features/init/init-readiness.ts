import type { GetInitStatusResponse } from '@monad/protocol';
import type { StudioSectionId } from '@/features/studio/sections';

export const runtimeDisabledSectionIds = [
  'models',
  'agents',
  'capabilities',
  'acpDelegates',
  'memory',
  'safety'
] as const satisfies readonly StudioSectionId[];

const runtimeDisabledSectionSet = new Set<StudioSectionId>(runtimeDisabledSectionIds);

export function isRuntimeReady(status: Pick<GetInitStatusResponse, 'initialized'> | undefined): boolean {
  return status?.initialized === true;
}

export function isRuntimeIncomplete(
  status: Pick<GetInitStatusResponse, 'initialized' | 'missing'> | undefined
): boolean {
  return !isRuntimeReady(status) || (status?.missing.length ?? 0) > 0;
}

export function runtimeSectionEnabled(section: StudioSectionId, runtimeReady: boolean): boolean {
  return runtimeReady || !runtimeDisabledSectionSet.has(section);
}
