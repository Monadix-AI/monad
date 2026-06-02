import type { WebMessageIdWithoutParams } from '@monad/i18n/browser';
import type { SkillMarketplaceSource, SkillSearchResult, SkillSortMode } from '@monad/protocol';
import type { SkillInstallAttempt, SkillPending } from './types';

import {
  Activity01Icon,
  ArrowLeft01Icon,
  Cancel01Icon,
  ExternalLinkIcon,
  LoaderPinwheelIcon,
  Search01Icon,
  SparklesIcon,
  ZapIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
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
import { Badge, Button, cn, Input, ScrollArea } from '@monad/ui';
import { Markdown } from '@monad/ui/components/Markdown';
import { useCallback, useEffect, useRef, useState } from 'react';

import { hoverActionsClassName, hoverActionsVisibleClassName } from '#/components/HoverActions';
import { useT } from '#/components/I18nProvider';
import { toast } from '#/components/ToastProvider';
import { skillMarketplacePath, skillMarketplaceSourceFromPathname } from '#/features/shell/routing/paths';
import { replaceShellUrl, useShellPathname } from '#/hooks/use-shell-location';
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

const MARKETPLACE_ICONS: Record<SkillMarketplaceSource, { src: string; fallback: string }> = {
  clawhub: { src: 'https://clawhub.ai/favicon.ico', fallback: 'C' },
  'skills.sh': { src: 'https://skills.sh/favicon.ico', fallback: 'S' },
  'mcpservers.org': { src: 'https://mcpservers.org/icon.png', fallback: 'M' },
  'ClaudeSkills.info': { src: 'https://claudeskills.info/favicon.ico', fallback: 'C' },
  SkillsLLM: { src: 'https://skillsllm.com/favicon.ico', fallback: 'L' }
};

const MARKETPLACE_SORT_TABS: { mode: SkillSortMode; icon: React.ReactNode; labelKey: WebMessageIdWithoutParams }[] = [
  {
    mode: 'trending',
    icon: (
      <HugeiconsIcon
        className="size-3.5"
        icon={Activity01Icon}
      />
    ),
    labelKey: 'web.skills.tabTrending'
  },
  {
    mode: 'top',
    icon: (
      <HugeiconsIcon
        className="size-3.5"
        icon={ZapIcon}
      />
    ),
    labelKey: 'web.skills.tabTop'
  },
  {
    mode: 'new',
    icon: (
      <HugeiconsIcon
        className="size-3.5"
        icon={SparklesIcon}
      />
    ),
    labelKey: 'web.skills.tabNew'
  }
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

function MarketplaceIcon({ source }: { source: SkillMarketplaceSource }) {
  const icon = MARKETPLACE_ICONS[source];
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span
        aria-hidden="true"
        className="grid size-4 shrink-0 place-items-center rounded-sm bg-muted text-[9px] text-muted-foreground"
      >
        {icon.fallback}
      </span>
    );
  }

  return (
    // biome-ignore lint/performance/noImgElement: Marketplace tabs intentionally use official site favicons directly.
    <img
      alt=""
      className="size-4 shrink-0 rounded-sm"
      onError={() => setFailed(true)}
      src={icon.src}
    />
  );
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
          <HugeiconsIcon
            className="size-4"
            icon={ArrowLeft01Icon}
          />
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
                      <HugeiconsIcon
                        className="size-3.5"
                        icon={ExternalLinkIcon}
                      />
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
                    {installing ? (
                      <HugeiconsIcon
                        className="size-3.5 animate-spin"
                        icon={LoaderPinwheelIcon}
                      />
                    ) : null}
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
  const pathname = useShellPathname();
  const routedSource = skillMarketplaceSourceFromPathname(pathname);
  const [sort, setSort] = useState<SkillSortMode>('trending');
  const [source, setSource] = useState<SkillMarketplaceSource>(routedSource ?? DEFAULT_SKILL_MARKETPLACE_SOURCE);
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
  const mountedRef = useRef(true);
  const consentToastIdsRef = useRef(new Map<string, string>());

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runSearch = useCallback(
    (opts?: { nextQuery?: string; nextSource?: SkillMarketplaceSource; nextSort?: SkillSortMode }) => {
      const q = (opts?.nextQuery ?? query).trim();
      if (q) {
        setVisibleCount(PAGE_SIZE);
        void search({ q, sort: opts?.nextSort ?? sort, source: opts?.nextSource ?? source });
      }
    },
    [query, search, sort, source]
  );

  const handleSortChange = (nextSort: SkillSortMode) => {
    setSort(nextSort);
    setDetailSkill(null);
    setVisibleCount(PAGE_SIZE);
    runSearch({ nextSort });
  };

  const handleSourceChange = (nextSource: SkillMarketplaceSource) => {
    const nextSort = marketplaceSupportsCuratedSorts(nextSource) ? sort : 'trending';
    setSource(nextSource);
    setSort(nextSort);
    setDetailSkill(null);
    setVisibleCount(PAGE_SIZE);
    runSearch({ nextSource, nextSort });
    replaceShellUrl(skillMarketplacePath(nextSource));
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
        const toastId = toast.info(t('web.skills.consentToast'), {
          action: {
            label: t('web.skills.consentConfirm'),
            onClick: async () => {
              const confirmed = await install({ source: installSource, consent: true })
                .unwrap()
                .catch(() => null);
              if (!confirmed || confirmed.needsConsent) {
                toast.error(t('web.skills.installFailed'));
                return false;
              }
              toast.success(t('web.skills.installSucceeded'));
              consentToastIdsRef.current.delete(resultKey);
              if (!mountedRef.current) return;
              setInstalled((prev) => new Set(prev).add(resultKey));
              setPending((prev) => {
                const m = new Map(prev);
                m.delete(resultKey);
                return m;
              });
              void onInstalled();
            }
          },
          detail: consentInfo,
          duration: Number.POSITIVE_INFINITY
        });
        consentToastIdsRef.current.set(resultKey, toastId);
        return { status: 'consent', consent: consentInfo };
      } else {
        setInstalled((prev) => new Set(prev).add(resultKey));
        const consentToastId = consentToastIdsRef.current.get(resultKey);
        if (consentToastId) toast.dismiss(consentToastId);
        consentToastIdsRef.current.delete(resultKey);
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

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setVisibleCount(PAGE_SIZE);
      return;
    }
    const timeout = window.setTimeout(() => runSearch({ nextQuery: q }), 250);
    return () => window.clearTimeout(timeout);
  }, [query, runSearch]);

  useEffect(() => {
    if (!routedSource || routedSource === source) return;
    const nextSort = marketplaceSupportsCuratedSorts(routedSource) ? sort : 'trending';
    setSource(routedSource);
    setSort(nextSort);
    setDetailSkill(null);
    setVisibleCount(PAGE_SIZE);
  }, [routedSource, sort, source]);

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
        const installVisibility =
          done || consent || isInstalling ? hoverActionsVisibleClassName : hoverActionsClassName;

        return (
          <div
            className={cn(layout.card, 'group')}
            data-slot="skill-browse-card"
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
                  className={cn(layout.installButton, 'transition-opacity duration-150 ease-out', installVisibility)}
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
                    <HugeiconsIcon
                      className="size-3 animate-spin text-foreground"
                      icon={LoaderPinwheelIcon}
                    />
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
      <div className="flex min-w-0 flex-col gap-2 border-b bg-muted/10 px-4 py-3">
        <div
          aria-label={t('web.skills.source')}
          className="-mx-1 flex min-w-0 gap-1 overflow-x-auto px-1 pb-0.5"
          role="tablist"
        >
          {SKILL_MARKETPLACE_SOURCES.map((option) => (
            <button
              aria-selected={source === option.source}
              className={cn(
                'inline-flex h-8 shrink-0 items-center gap-2 rounded-md border border-transparent px-2.5 font-medium text-muted-foreground text-xs transition-[background-color,border-color,color] duration-150 ease-out hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                source === option.source &&
                  'border-border/70 bg-background/80 text-foreground shadow-sm hover:bg-background/80'
              )}
              key={option.source}
              onClick={() => handleSourceChange(option.source)}
              role="tab"
              type="button"
            >
              <MarketplaceIcon source={option.source} />
              <span className="whitespace-nowrap">{option.label}</span>
            </button>
          ))}
        </div>

        <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <HugeiconsIcon
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              icon={Search01Icon}
            />
            <Input
              className="h-8 pr-8 pl-8"
              onChange={(e) => {
                setQuery(e.target.value);
                setVisibleCount(PAGE_SIZE);
              }}
              onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              placeholder={t('web.skills.browsePlaceholder', { source: marketplaceLabel(source) })}
              value={query}
            />
            {query ? (
              <Button
                aria-label={t('web.common.clear')}
                className="absolute top-1/2 right-1 size-6 -translate-y-1/2 text-muted-foreground"
                onClick={() => {
                  setQuery('');
                  setVisibleCount(PAGE_SIZE);
                }}
                size="icon"
                variant="ghost"
              >
                <HugeiconsIcon
                  className="size-3.5"
                  icon={Cancel01Icon}
                />
              </Button>
            ) : null}
          </div>

          {supportsCuratedSorts ? (
            <div
              aria-label={t('web.skills.sort')}
              className="inline-flex min-w-0 items-center gap-0.5 self-start rounded-md border border-border/70 bg-muted/20 p-0.5 lg:self-auto"
              role="tablist"
            >
              {MARKETPLACE_SORT_TABS.map((tab) => (
                <Button
                  aria-selected={sort === tab.mode}
                  className={cn(
                    'h-7 justify-start gap-1.5 rounded-sm px-2 text-muted-foreground text-xs hover:bg-accent hover:text-accent-foreground',
                    sort === tab.mode && 'bg-background text-foreground shadow-sm hover:bg-background'
                  )}
                  key={tab.mode}
                  onClick={() => handleSortChange(tab.mode)}
                  role="tab"
                  size="sm"
                  variant="ghost"
                >
                  {tab.icon}
                  {t(tab.labelKey)}
                </Button>
              ))}
            </div>
          ) : null}
          {isFetching && isSearching ? (
            <HugeiconsIcon
              className="size-3.5 shrink-0 animate-spin text-muted-foreground"
              icon={LoaderPinwheelIcon}
            />
          ) : null}
        </div>
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
