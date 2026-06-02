export type RightPanelOwnerId = string | null;

type RightPanelContentRegistration = {
  id: string;
  ownerId: string;
};

export type RightPanelOwnership = {
  activeOwnerId: RightPanelOwnerId;
  registration: RightPanelContentRegistration | null;
};

export function createRightPanelOwnership(activeOwnerId: RightPanelOwnerId): RightPanelOwnership {
  return { activeOwnerId, registration: null };
}

export function activateRightPanelOwner(
  state: RightPanelOwnership,
  activeOwnerId: RightPanelOwnerId
): RightPanelOwnership {
  if (state.activeOwnerId === activeOwnerId) return state;
  return { activeOwnerId, registration: null };
}

export function registerRightPanelContent(
  state: RightPanelOwnership,
  ownerId: string,
  registrationId: string
): RightPanelOwnership {
  if (state.activeOwnerId !== ownerId) return state;
  return { ...state, registration: { id: registrationId, ownerId } };
}

export function unregisterRightPanelContent(state: RightPanelOwnership, registrationId: string): RightPanelOwnership {
  if (state.registration?.id !== registrationId) return state;
  return { ...state, registration: null };
}

export function canRenderRightPanelContent(
  state: RightPanelOwnership,
  ownerId: string,
  registrationId: string
): boolean {
  return (
    state.activeOwnerId === ownerId &&
    state.registration?.ownerId === ownerId &&
    state.registration.id === registrationId
  );
}
