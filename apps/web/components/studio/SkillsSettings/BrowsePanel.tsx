import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type { SkillMarketplaceSource, SkillSearchResult, SkillSortMode } from '@monad/protocol';
import type { SkillInstallAttempt, SkillPending } from './types';

import {
  useBrowseSkillsQuery,
  useFetchSkillDetailQuery,
  useInstallSkillMutation,
  useLazySearchSkillsQuery
} from '@monad/client-rtk';
import {
  DEFAULT_SKILL_MARKETPLACE_SOURCE,
  SKILL_MARKETPLACE_SOURCES,
  skillMarketplaceSourceMeta
} from '@monad/protocol';
import {
  Badge,
  Button,
  cn,
  Input,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@monad/ui';
import { ArrowLeft, ExternalLink, Loader2, Search, Sparkles, TrendingUp, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { Markdown } from '@/components/Markdown';
import { ConsentPopover } from './ConsentPopover';
import {
  BROWSE_MORE_SKELETON_KEYS,
  BROWSE_SKILL_SKELETON_KEYS,
  BrowseSkillCardSkeleton,
  SkeletonBlock,
  SkillDetailSkeleton
} from './skeletons';
import { safeHttpUrl } from './utils';

const PAGE_SIZE = 10;

const MARKETPLACE_SORT_TABS: { mode: SkillSortMode; icon: React.ReactNode; labelKey: WebMessageIdWithoutParams }[] = [
  { mode: 'trending', icon: <TrendingUp className="size-3.5" />, labelKey: 'web.skills.tabTrending' },
  { mode: 'top', icon: <Zap className="size-3.5" />, labelKey: 'web.skills.tabTop' },
  { mode: 'new', icon: <Sparkles className="size-3.5" />, labelKey: 'web.skills.tabNew' }
];

function marketplaceLabel(source: SkillMarketplaceSource): string {
  return skillMarketplaceSourceMeta(source).label;
}

function marketplaceSupportsCuratedSorts(source: SkillMarketplaceSource): boolean {
  return skillMarketplaceSourceMeta(source).supportsCuratedSorts;
}

function marketplaceRequiresInstallSource(source: SkillMarketplaceSource): boolean {
  return skillMarketplaceSourceMeta(source).requiresInstallSource;
}

function marketplaceInstallSourcePrefix(source: SkillMarketplaceSource): string | undefined {
  return skillMarketplaceSourceMeta(source).installSourcePrefix;
}

function installResultKey(result: Pick<SkillSearchResult, 'id' | 'installSource'>): string {
  return result.installSource ?? result.id;
}

function resolveInstallSource(result: Pick<SkillSearchResult, 'id' | 'source' | 'installSource'>): string | null {
  const explicit = result.installSource;
  if (explicit) return explicit;
  const prefix = marketplaceInstallSourcePrefix(result.source);
  return prefix ? `${prefix}${result.id}` : null;
}

function SkillDetailView({
  slug,
  source,
  onBack,
  onInstall
}: {
  slug: string;
  source: SkillMarketplaceSource;
  onBack: () => void;
  onInstall: (
    result: Pick<SkillSearchResult, 'id' | 'source' | 'installSource'>,
    consent: boolean
  ) => Promise<SkillInstallAttempt>;
}) {
  const t = useT();
  const { data, isFetching, isError } = useFetchSkillDetailQuery({ slug, source });
  const [installing, setInstalling] = useState(false);
  const [done, setDone] = useState(false);
  const [consent, setConsent] = useState<{ skills: string[]; warnings: string[] } | null>(null);

  const handleInstall = async (withConsent: boolean) => {
    setInstalling(true);
    try {
      const result = await onInstall({ id: slug, source, installSource: data?.installSource ?? null }, withConsent);
      if (result.status === 'consent') {
        setConsent(result.consent);
        return;
      }
      if (result.status === 'installed') {
        setConsent(null);
        setDone(true);
      }
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Button
          aria-label={t('web.common.back')}
          className="size-7"
          onClick={onBack}
          size="icon"
          variant="ghost"
        >
          <ArrowLeft className="size-4" />
        </Button>
        {isFetching ? (
          <>
            <SkeletonBlock className="h-4 w-40" />
            <SkeletonBlock className="h-5 w-12 rounded-full" />
          </>
        ) : data ? (
          <>
            <span className="truncate font-medium text-sm">{data.name}</span>
            {data.version ? (
              <Badge
                className="text-[10px]"
                variant="secondary"
              >
                {data.version}
              </Badge>
            ) : null}
            {data.downloads != null ? (
              <span className="text-[10px] text-muted-foreground">{data.downloads.toLocaleString()} ↓</span>
            ) : null}
            <div className="ml-auto">
              <div className="flex items-center gap-2">
                {safeHttpUrl(data.homepage) ? (
                  <Button
                    asChild
                    size="icon"
                    variant="ghost"
                  >
                    <a
                      href={safeHttpUrl(data.homepage)}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                  </Button>
                ) : null}
                <ConsentPopover
                  consent={consent}
                  id={slug}
                  installingId={installing ? slug : null}
                  onCancel={() => setConsent(null)}
                  onConfirm={async () => {
                    await handleInstall(true);
                  }}
                >
                  <Button
                    disabled={
                      done || installing || (marketplaceRequiresInstallSource(data.source) && !data.installSource)
                    }
                    onClick={() => void handleInstall(false)}
                    size="sm"
                    variant="ghost"
                  >
                    {installing ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    {done ? '✓' : consent ? t('web.skills.consentReview') : t('web.skills.browseInstall')}
                  </Button>
                </ConsentPopover>
              </div>
            </div>
          </>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {isError ? (
          <p className="px-4 py-8 text-center text-destructive text-xs">{t('web.skills.browseError')}</p>
        ) : isFetching ? (
          <SkillDetailSkeleton />
        ) : data ? (
          <div className="flex flex-col gap-3 p-4">
            {data.summary ? <p className="text-muted-foreground text-sm">{data.summary}</p> : null}
            {data.installSource ? (
              <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
                <code className="rounded bg-muted px-1.5 py-0.5">{data.installSource}</code>
              </div>
            ) : null}
            <Markdown text={data.content} />
          </div>
        ) : null}
      </ScrollArea>
    </div>
  );
}

export function BrowsePanel({
  onInstalled,
  onInstallFailed
}: {
  onInstalled: () => Promise<void>;
  onInstallFailed: () => void;
}) {
  const t = useT();
  const [sort, setSort] = useState<SkillSortMode>('trending');
  const [source, setSource] = useState<SkillMarketplaceSource>(DEFAULT_SKILL_MARKETPLACE_SOURCE);
  const [query, setQuery] = useState('');
  const [detailSkill, setDetailSkill] = useState<Pick<SkillSearchResult, 'id' | 'source' | 'installSource'> | null>(
    null
  );
  const supportsCuratedSorts = marketplaceSupportsCuratedSorts(source);
  const isSearching = query.trim().length > 0;
  const browseResult = useBrowseSkillsQuery({ sort, source });
  const [search, searchResult] = useLazySearchSkillsQuery();
  const activeResult = isSearching ? searchResult : browseResult;
  const data = activeResult.currentData ?? (activeResult.isFetching ? undefined : activeResult.data);
  const { isFetching, isError } = activeResult;
  const [install] = useInstallSkillMutation();
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Map<string, SkillPending>>(new Map());
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const browseScrollRootRef = useRef<HTMLDivElement>(null);

  const runSearch = () => {
    const q = query.trim();
    if (q) {
      setVisibleCount(PAGE_SIZE);
      void search({ q, source });
    }
  };

  const handleSortChange = (nextSort: SkillSortMode) => {
    setSort(nextSort);
    setDetailSkill(null);
    setVisibleCount(PAGE_SIZE);
  };

  const startInstall = async (
    result: Pick<SkillSearchResult, 'id' | 'source' | 'installSource'>,
    consent: boolean
  ): Promise<SkillInstallAttempt> => {
    const resultKey = installResultKey(result);
    setInstallingId(resultKey);
    try {
      const installSource = resolveInstallSource(result);
      if (!installSource) {
        onInstallFailed();
        return { status: 'failed' };
      }
      const res = await install({ source: installSource, consent })
        .unwrap()
        .catch(() => null);
      if (!res) {
        onInstallFailed();
        return { status: 'failed' };
      }
      if (res.needsConsent) {
        const consentInfo = { skills: res.skills, warnings: res.warnings };
        setPending((prev) => new Map(prev).set(resultKey, consentInfo));
        return { status: 'consent', consent: consentInfo };
      } else {
        setInstalled((prev) => new Set(prev).add(resultKey));
        setPending((prev) => {
          const m = new Map(prev);
          m.delete(resultKey);
          return m;
        });
        void onInstalled();
        return { status: 'installed' };
      }
    } finally {
      setInstallingId(null);
    }
  };

  const cancelPending = (id: string) =>
    setPending((prev) => {
      const m = new Map(prev);
      m.delete(id);
      return m;
    });

  const results = data?.results ?? [];
  const hasMoreResults = results.length > visibleCount;

  useEffect(() => {
    if (!hasMoreResults) return;
    const viewport = browseScrollRootRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const loadMoreIfNeeded = () => {
      const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      if (distanceToBottom < 240) {
        setVisibleCount((count) => Math.min(count + PAGE_SIZE, results.length));
      }
    };
    loadMoreIfNeeded();
    viewport.addEventListener('scroll', loadMoreIfNeeded, { passive: true });
    return () => viewport.removeEventListener('scroll', loadMoreIfNeeded);
  }, [hasMoreResults, results.length]);

  if (detailSkill) {
    return (
      <SkillDetailView
        onBack={() => setDetailSkill(null)}
        onInstall={startInstall}
        slug={detailSkill.id}
        source={detailSkill.source}
      />
    );
  }

  const renderBrowseResults = (layout: {
    card: string;
    cardContainer: string;
    description: string;
    installButton: string;
    metaRow: string;
  }) => (
    <div className={cn('p-4', layout.cardContainer)}>
      {isFetching && results.length === 0 ? (
        BROWSE_SKILL_SKELETON_KEYS.map((key) => (
          <BrowseSkillCardSkeleton
            className={layout.card}
            key={key}
          />
        ))
      ) : isError ? (
        <p className="col-span-full px-1 py-8 text-center text-destructive text-xs">{t('web.skills.browseError')}</p>
      ) : results.length === 0 && isSearching ? (
        <p className="col-span-full px-1 py-8 text-center text-muted-foreground text-xs">
          {t('web.skills.browseEmpty')}
        </p>
      ) : null}

      {results.slice(0, visibleCount).map((r) => {
        const resultKey = installResultKey(r);
        const done = installed.has(resultKey);
        const consent = pending.get(resultKey);
        const isInstalling = installingId === resultKey;

        return (
          <div
            className={layout.card}
            key={resultKey}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <button
                className="truncate text-left font-medium text-sm hover:underline"
                onClick={() => setDetailSkill({ id: r.id, source: r.source, installSource: r.installSource })}
                type="button"
              >
                {r.name}
              </button>
              {r.description ? <p className={layout.description}>{r.description}</p> : null}
            </div>
            <div className={layout.metaRow}>
              {r.version ? (
                <Badge
                  className="text-[10px]"
                  variant="secondary"
                >
                  {r.version}
                </Badge>
              ) : null}
              {r.downloads != null ? (
                <span className="text-[10px] text-muted-foreground">{r.downloads.toLocaleString()} ↓</span>
              ) : null}
              <ConsentPopover
                consent={consent}
                id={resultKey}
                installingId={installingId}
                onCancel={cancelPending}
                onConfirm={() => startInstall(r, true)}
              >
                <Button
                  className={layout.installButton}
                  disabled={
                    done ||
                    isInstalling ||
                    installingId !== null ||
                    (marketplaceRequiresInstallSource(r.source) && !r.installSource)
                  }
                  onClick={() => void startInstall(r, false)}
                  size="sm"
                  variant="ghost"
                >
                  {isInstalling ? (
                    <Loader2 className="size-3 animate-spin text-foreground" />
                  ) : done ? (
                    '✓'
                  ) : consent ? (
                    t('web.skills.consentReview')
                  ) : (
                    t('web.skills.browseInstall')
                  )}
                </Button>
              </ConsentPopover>
            </div>
          </div>
        );
      })}

      {hasMoreResults
        ? BROWSE_MORE_SKELETON_KEYS.map((key) => (
            <BrowseSkillCardSkeleton
              className={layout.card}
              key={key}
            />
          ))
        : null}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/10 px-4 py-2">
        <Select
          onValueChange={(value) => {
            const nextSource = value as SkillMarketplaceSource;
            setSource(nextSource);
            setDetailSkill(null);
            setVisibleCount(PAGE_SIZE);
            if (query.trim()) {
              void search({ q: query.trim(), source: nextSource });
            }
          }}
          value={source}
        >
          <SelectTrigger className="h-7 w-[180px] border-border/70 bg-background/60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SKILL_MARKETPLACE_SOURCES.map((option) => (
              <SelectItem
                key={option.source}
                value={option.source}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {supportsCuratedSorts ? (
          <div className="inline-flex min-w-0 items-center gap-0.5 rounded-md border border-border/70 bg-muted/20 p-0.5">
            {MARKETPLACE_SORT_TABS.map((tab) => (
              <Button
                className={cn(
                  'h-7 justify-start gap-1.5 rounded-sm px-2 text-muted-foreground text-xs hover:bg-accent hover:text-accent-foreground',
                  sort === tab.mode && 'bg-background text-foreground shadow-sm hover:bg-background'
                )}
                key={tab.mode}
                onClick={() => handleSortChange(tab.mode)}
                size="sm"
                variant="ghost"
              >
                {tab.icon}
                {t(tab.labelKey)}
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex gap-2 border-b px-4 py-3">
        <Input
          className="flex-1"
          onChange={(e) => {
            setQuery(e.target.value);
            setVisibleCount(PAGE_SIZE);
          }}
          onKeyDown={(e) => e.key === 'Enter' && runSearch()}
          placeholder={t('web.skills.browsePlaceholder', { source: marketplaceLabel(source) })}
          value={query}
        />
        <Button
          disabled={isFetching || !query.trim()}
          onClick={runSearch}
          size="sm"
          variant="secondary"
        >
          {isFetching && isSearching ? (
            <Loader2 className="size-3.5 animate-spin text-foreground" />
          ) : (
            <Search className="size-3.5" />
          )}
        </Button>
      </div>

      <div
        className="min-h-0 flex-1"
        ref={browseScrollRootRef}
      >
        <ScrollArea className="h-full">
          {renderBrowseResults({
            card: 'flex min-h-28 flex-col gap-2 rounded-md border border-border/70 bg-muted/10 p-3',
            cardContainer: 'grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2.5',
            description: 'line-clamp-2 text-muted-foreground text-xs leading-5',
            installButton: 'ml-auto h-6 px-2 text-xs',
            metaRow: 'flex items-center gap-1.5 pt-1'
          })}
        </ScrollArea>
      </div>
    </div>
  );
}
