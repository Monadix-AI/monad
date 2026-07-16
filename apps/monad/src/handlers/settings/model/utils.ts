import type { Credential, MonadConfig, Provider } from '@monad/environment';
import type { CredentialView, ModelInfo, ProfileView, ProviderView } from '@monad/protocol';
import type { ModelContext } from '#/handlers/settings/model/context.ts';

import { ModelProviderType } from '@monad/protocol';

export function providerToView(provider: Provider): ProviderView {
  return {
    id: provider.id,
    label: provider.label,
    type: provider.type,
    baseUrl: provider.baseUrl,
    extra: provider.extra,
    enabled: provider.enabled
  };
}

export function viewToProvider(v: ProviderView): Provider {
  if (!isKnownProviderType(v.type)) {
    throw new Error(`unknown provider type "${v.type}"`);
  }
  return { id: v.id, label: v.label, type: v.type, baseUrl: v.baseUrl, extra: v.extra, enabled: v.enabled };
}

function isKnownProviderType(value: string): value is Provider['type'] {
  return Object.values(ModelProviderType).includes(value as Provider['type']);
}

export function profileToView(p: MonadConfig['model']['profiles'][number]): ProfileView {
  return {
    alias: p.alias,
    routes: p.routes,
    params: p.params,
    routeParams: p.routeParams,
    fallbacks: p.fallbacks
  };
}

export function viewToProfile(v: ProfileView): MonadConfig['model']['profiles'][number] {
  return {
    alias: v.alias,
    routes: v.routes,
    params: v.params,
    routeParams: v.routeParams,
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

function positiveContextLimit(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
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

export function enrichModelInfo(
  ctx: ModelContext,
  cfg: MonadConfig,
  provider: Pick<Provider, 'id' | 'type'>,
  model: ModelInfo
): ModelInfo {
  // Prefer provider-native metadata; fill missing fields from the models.dev catalog.
  const price = model.price ?? ctx.lookupPriceExact(provider.type, model.id);
  const contextLimit =
    positiveContextLimit(model.contextLimit) ?? positiveContextLimit(ctx.lookupContextLimit(provider.type, model.id));
  const releaseDate = model.releaseDate ?? ctx.lookupReleaseDate(provider.type, model.id);
  const modelsDevUrl = model.modelsDevUrl ?? ctx.lookupModelsDevUrl(provider.type, model.id);
  const detailUrl = model.detailUrl ?? modelsDevUrl;
  const label = model.label ?? ctx.lookupLabel(provider.type, model.id);
  const inferred = model.modalities ?? ctx.lookupCapabilities(provider.type, model.id);
  // A manual kind override (config model.kinds) is the final authority — it can correct or
  // supply a kind the layered inference missed (e.g. an embedding id the heuristic won't match).
  const override = cfg.model.kinds[`${provider.id}:${model.id}`];
  const modalities = override ? { ...(inferred ?? {}), kind: override } : inferred;
  const { contextLimit: _rawContextLimit, ...baseModel } = model;

  return {
    ...baseModel,
    ...(label ? { label } : {}),
    ...(price && Object.keys(price).length > 0 ? { price } : {}),
    ...(contextLimit !== undefined ? { contextLimit } : {}),
    ...(releaseDate ? { releaseDate } : {}),
    ...(detailUrl ? { detailUrl } : {}),
    ...(modelsDevUrl ? { modelsDevUrl } : {}),
    ...(modalities ? { modalities } : {})
  };
}
