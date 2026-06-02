import type { ChannelIcon, ModelProviderDescriptor } from '@monad/protocol';
import type React from 'react';

import { useProviderCatalogQuery } from '@monad/client-rtk';

import { BrandIcon } from '#/components/BrandIcon';

type LogoProps = { className?: string };

interface ProviderUI {
  logo: React.ComponentType<LogoProps>;
  color: string;
}

export type ProviderMeta = ModelProviderDescriptor & ProviderUI;

const FALLBACK_ICON: ChannelIcon = {
  title: 'Model provider',
  path: 'M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5'
};

function withUi(descriptor: ModelProviderDescriptor): ProviderMeta {
  const icon = descriptor.icon;
  const Logo = ({ className }: LogoProps) => (
    <BrandIcon
      className={className}
      icon={icon}
    />
  );
  return { ...descriptor, logo: Logo, color: '' };
}

export function useProviderMeta(): {
  metaFor: (type: string) => ProviderMeta;
  catalog: ModelProviderDescriptor[];
  isLoading: boolean;
} {
  const { data, isLoading } = useProviderCatalogQuery();
  const catalog = data ?? [];
  const byType = new Map(catalog.map((descriptor) => [descriptor.type, descriptor] as const));
  const metaFor = (type: string): ProviderMeta =>
    withUi(byType.get(type) ?? { type, label: type, icon: FALLBACK_ICON, strategy: 'openai-compatible' });
  return { metaFor, catalog, isLoading };
}
