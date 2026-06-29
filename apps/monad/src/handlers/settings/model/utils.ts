import type { Credential, MonadConfig, Provider } from '@monad/home';
import type { CredentialView, ProfileView, ProviderView } from '@monad/protocol';

import { ModelProviderType } from '@monad/protocol';

export function providerToView(provider: Provider): ProviderView {
  return {
    id: provider.id,
    label: provider.label,
    type: provider.type,
    baseUrl: provider.baseUrl,
    extra: provider.extra
  };
}

export function viewToProvider(v: ProviderView): Provider {
  if (!isKnownProviderType(v.type)) {
    throw new Error(`unknown provider type "${v.type}"`);
  }
  return { id: v.id, label: v.label, type: v.type, baseUrl: v.baseUrl, extra: v.extra };
}

function isKnownProviderType(value: string): value is Provider['type'] {
  return Object.values(ModelProviderType).includes(value as Provider['type']);
}

export function profileToView(p: MonadConfig['model']['profiles'][number]): ProfileView {
  return {
    alias: p.alias,
    routes: p.routes,
    params: p.params,
    fallbacks: p.fallbacks
  };
}

export function viewToProfile(v: ProfileView): MonadConfig['model']['profiles'][number] {
  return {
    alias: v.alias,
    routes: v.routes,
    params: v.params,
    fallbacks: v.fallbacks
  };
}

export function credentialToView(c: Credential): CredentialView {
  return {
    id: c.id,
    label: c.label,
    authType: c.authType,
    priority: c.priority,
    source: c.source,
    baseUrl: c.baseUrl,
    lastStatus: c.lastStatus,
    requestCount: c.requestCount,
    accessTokenPreview: maskSecret(c.accessToken)
  };
}

function maskSecret(token: string): string {
  return token.length > 4 ? `...${token.slice(-4)}` : '...';
}

export function providerToResolved(provider: Provider): {
  id: string;
  type: ModelProviderType;
  baseUrl?: string;
  extra?: Record<string, string>;
} {
  return {
    id: provider.id,
    type: provider.type as ModelProviderType,
    baseUrl: provider.baseUrl,
    extra: provider.extra
  };
}

export function credentialToHandle(c: Credential): {
  id: string;
  accessToken: string;
  authType: 'api_key' | 'oauth' | 'admin_api_key';
  baseUrl?: string;
  priority: number;
} {
  return { id: c.id, accessToken: c.accessToken, authType: c.authType, baseUrl: c.baseUrl, priority: c.priority };
}
