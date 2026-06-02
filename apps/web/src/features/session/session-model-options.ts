import type { ModelInfo, ProfileView, ProviderView } from '@monad/protocol';

export type SessionModelProviderOption = {
  label: string;
  models: Array<{ displayName: string; effort?: string; efforts?: string[]; label: string; value: string }>;
  value: string;
};

export type SessionModelSelectionState = {
  effectiveModel?: string;
  override?: string;
};

export type SessionModelSelectionTarget = { type: 'model'; value: string } | { type: 'profile' };

function supportsChat(model: ModelInfo): boolean {
  const modalities = model.modalities;
  if (!modalities) return true;
  return Boolean(modalities.input?.includes('text') && modalities.output?.includes('text'));
}

export function resolveAgentProfileDefault(
  profiles: ProfileView[],
  defaultAlias: string | undefined,
  agentProfileAlias: string | undefined
): ProfileView | undefined {
  return (
    profiles.find((profile) => profile.alias === agentProfileAlias) ??
    profiles.find((profile) => profile.alias === defaultAlias) ??
    profiles[0]
  );
}

export function nextSessionModelCommand(
  current: SessionModelSelectionState,
  target: SessionModelSelectionTarget
): string | null {
  if (target.type === 'profile') return current.override ? '/model inherit' : null;
  if (!target.value || target.value === current.effectiveModel) return null;
  return `/model ${target.value}`;
}

export function buildSessionModelProviders(
  providers: Array<Pick<ProviderView, 'id' | 'label'>>,
  modelsByProvider: Record<string, ModelInfo[]>
): SessionModelProviderOption[] {
  return providers.flatMap((provider) => {
    const models = (modelsByProvider[provider.id] ?? []).filter(supportsChat);
    if (models.length === 0) return [];
    return [
      {
        label: provider.label,
        models: models.map((model) => {
          const label = model.label ?? model.id;
          const efforts = model.modalities?.reasoningEfforts?.filter((effort) => effort.trim().length > 0) ?? [];
          const defaultEffort = model.modalities?.defaultReasoningEffort;
          return {
            displayName: label,
            ...(defaultEffort && efforts.includes(defaultEffort) ? { effort: defaultEffort } : {}),
            ...(efforts.length > 0 ? { efforts } : {}),
            label,
            value: `${provider.id}:${model.id}`
          };
        }),
        value: provider.id
      }
    ];
  });
}
