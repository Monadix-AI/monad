import type { Agent, ProfileView, ProviderView } from '@monad/protocol';

export type DeleteBlock =
  | { kind: 'default-profile' }
  | { kind: 'single-profile' }
  | { kind: 'agent'; name: string }
  | { kind: 'profile'; alias: string };

export function providerDeleteBlock(provider: ProviderView, profiles: ProfileView[]): DeleteBlock | null {
  const profile = profiles.find((profile) =>
    Object.values(profile.routes).some((route) => route?.provider === provider.id)
  );
  return profile ? { kind: 'profile', alias: profile.alias } : null;
}

export function profileDeleteBlock(
  profile: ProfileView,
  profiles: ProfileView[],
  agents: Pick<Agent, 'model' | 'modelAlias' | 'name'>[],
  defaultAlias: string
): DeleteBlock | null {
  if (profile.alias === defaultAlias) return { kind: 'default-profile' };
  if (profiles.length <= 1) return { kind: 'single-profile' };
  const agent = agents.find((agent) => agent.modelAlias === profile.alias || agent.model === profile.alias);
  return agent ? { kind: 'agent', name: agent.name } : null;
}
