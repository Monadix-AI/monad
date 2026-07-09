'use client';

import type {
  CapabilityInventoryItem,
  CapabilityInventoryRoot,
  CapabilityInventorySource,
  ImportSettingsAction,
  ImportSettingsItem,
  ImportSettingsPreview,
  ImportSettingsRisk,
  ImportSettingsSource
} from '@monad/protocol';
import type { ProductIconId } from '@monad/ui';
import type { StudioSectionProps } from '../section-registry';

import { Alert01Icon, CheckmarkCircle02Icon, Refresh01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  useApplySettingsImportMutation,
  useGetCapabilityInventoryQuery,
  usePreviewSettingsImportMutation
} from '@monad/client-rtk';
import { Badge, Button, cn, ProductIcon } from '@monad/ui';
import { useEffect, useMemo, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { PanelShell, PanelShellBody } from '#/components/ui/panel-shell';
import { StudioBreadcrumbHeader } from '#/features/studio/StudioBreadcrumbHeader';

type DetectedAgent = {
  key: string;
  label: string;
  source: CapabilityInventorySource;
  from: ImportSettingsSource | null;
  importPath: string;
  roots: CapabilityInventoryRoot[];
  items: CapabilityInventoryItem[];
  counts: Record<CapabilityInventoryItem['kind'], number>;
};

const IMPORTABLE_SOURCES = new Set<CapabilityInventorySource>([
  'codex',
  'claude-code',
  'cursor',
  'hermes',
  'openclaw',
  'vscode'
]);

const CATEGORY_LABELS: Record<string, string> = {
  agents: 'Agents',
  skills: 'Skills',
  mcpServers: 'MCP servers',
  modelProviders: 'Model providers',
  modelProfiles: 'Model profiles',
  modelRoles: 'Model roles',
  credentials: 'Credentials',
  hooks: 'Hooks',
  sandbox: 'Sandbox',
  approvals: 'Approvals',
  tools: 'Tools',
  channels: 'Channels',
  plugins: 'Plugins',
  externalAgents: 'External agents'
};

const ACTION_TONE: Record<ImportSettingsAction, string> = {
  add: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700',
  update: 'border-blue-500/30 bg-blue-500/10 text-blue-700',
  skip: 'border-muted bg-muted text-muted-foreground',
  conflict: 'border-violet-500/30 bg-violet-500/10 text-violet-700',
  manual: 'border-amber-500/30 bg-amber-500/10 text-amber-700'
};

const RISK_TONE: Record<ImportSettingsRisk, string> = {
  low: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700',
  medium: 'border-amber-500/30 bg-amber-500/10 text-amber-700',
  high: 'border-destructive/30 bg-destructive/10 text-destructive'
};

export function StudioImportSettings(_props: StudioSectionProps) {
  const t = useT();
  const inventoryQ = useGetCapabilityInventoryQuery();
  const [previewImport, previewState] = usePreviewSettingsImportMutation();
  const [applyImport, applyState] = useApplySettingsImportMutation();
  const agents = useMemo(
    () => detectedAgents(inventoryQ.data?.roots ?? [], inventoryQ.data?.items ?? []),
    [inventoryQ.data]
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportSettingsPreview | null>(null);
  const [result, setResult] = useState<{ applied: number; skipped: number } | null>(null);
  const selectedAgent = agents.find((agent) => agent.key === selectedKey) ?? agents[0] ?? null;
  const items = preview?.items ?? [];
  const activeItem = items.find((item) => item.id === activeItemId) ?? items[0] ?? null;
  const applicableItems = items.filter(isApplicableItem);

  useEffect(() => {
    if (!selectedKey && agents[0]) setSelectedKey(agents[0].key);
  }, [agents, selectedKey]);

  useEffect(() => {
    if (!selectedAgent?.from) {
      setPreview(null);
      setSelectedIds(new Set());
      setActiveItemId(null);
      return;
    }
    let cancelled = false;
    setResult(null);
    setSelectedIds(new Set());
    void previewImport({ from: selectedAgent.from, path: selectedAgent.importPath, replace: false })
      .unwrap()
      .then((nextPreview) => {
        if (cancelled) return;
        setPreview(nextPreview);
        setActiveItemId(nextPreview.items[0]?.id ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setPreview(null);
        setActiveItemId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [previewImport, selectedAgent]);

  const groupedItems = useMemo(() => groupImportItems(items), [items]);
  const selectedCount = selectedIds.size;

  async function refreshPreview() {
    if (!selectedAgent?.from) return;
    const nextPreview = await previewImport({
      from: selectedAgent.from,
      path: selectedAgent.importPath,
      replace: false
    }).unwrap();
    setPreview(nextPreview);
    setSelectedIds(new Set());
    setActiveItemId(nextPreview.items[0]?.id ?? null);
    setResult(null);
  }

  async function applySelected() {
    if (!selectedAgent?.from || !preview || selectedIds.size === 0) return;
    const hashes = Object.fromEntries(preview.items.map((item) => [item.id, item.hash]));
    const applied = await applyImport({
      from: selectedAgent.from,
      path: selectedAgent.importPath,
      replace: false,
      select: Array.from(selectedIds),
      allSafe: false,
      hashes
    }).unwrap();
    setPreview(applied.preview);
    setSelectedIds(new Set());
    setActiveItemId(applied.preview.items[0]?.id ?? null);
    setResult({ applied: applied.applied.length, skipped: applied.skipped.length });
  }

  return (
    <PanelShell>
      <StudioBreadcrumbHeader title={t('web.settings.import')} />
      <PanelShellBody
        className="overflow-y-auto"
        data-slot="studio-import-panel"
      >
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4 lg:p-5">
          <div className="flex flex-col gap-1">
            <h2 className="font-semibold text-base">Detected agent import</h2>
            <p className="max-w-3xl text-muted-foreground text-sm">
              Review one detected agent at a time before importing its resources into Monad. Nothing is selected by
              default.
            </p>
          </div>

          <div className="grid min-h-[640px] gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
            <aside className="flex min-h-0 flex-col rounded-md border bg-card">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <span className="font-medium text-sm">Detected agents</span>
                <Badge
                  className="text-[10px]"
                  variant="secondary"
                >
                  {agents.length}
                </Badge>
              </div>
              <div className="min-h-0 overflow-auto p-2">
                {inventoryQ.isLoading ? (
                  <div className="px-2 py-8 text-center text-muted-foreground text-sm">
                    Scanning local agent installs…
                  </div>
                ) : agents.length === 0 ? (
                  <div className="px-2 py-8 text-center text-muted-foreground text-sm">
                    No importable detected agents yet.
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {agents.map((agent) => (
                      <AgentButton
                        active={agent.key === selectedAgent?.key}
                        agent={agent}
                        key={agent.key}
                        onSelect={() => {
                          setSelectedKey(agent.key);
                          setPreview(null);
                          setSelectedIds(new Set());
                          setActiveItemId(null);
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </aside>

            <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
              <div className="flex min-w-0 flex-col rounded-md border bg-card">
                <ImportHeader
                  agent={selectedAgent}
                  itemCount={items.length}
                  loading={previewState.isLoading}
                  onRefresh={refreshPreview}
                />

                {previewState.isError ? (
                  <div className="m-3 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
                    <HugeiconsIcon icon={Alert01Icon} />
                    Preview failed for this detected agent.
                  </div>
                ) : null}

                {result ? (
                  <div className="m-3 flex items-center gap-2 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-emerald-700 text-sm">
                    <HugeiconsIcon icon={CheckmarkCircle02Icon} />
                    {result.applied} applied, {result.skipped} skipped.
                  </div>
                ) : null}

                <div className="min-h-0 flex-1 overflow-auto p-3">
                  {!selectedAgent ? (
                    <EmptyReview message="Select a detected agent to preview its importable resources." />
                  ) : !selectedAgent.from ? (
                    <EmptyReview message="This detected agent is visible, but Monad cannot import from this source yet." />
                  ) : previewState.isLoading && !preview ? (
                    <EmptyReview message="Building import preview…" />
                  ) : items.length === 0 ? (
                    <EmptyReview message="No importable resources were found for this agent." />
                  ) : (
                    <div className="flex flex-col gap-3">
                      {groupedItems.map(([category, categoryItems]) => (
                        <ImportCategory
                          activeItemId={activeItem?.id ?? null}
                          items={categoryItems}
                          key={category}
                          label={CATEGORY_LABELS[category] ?? category}
                          onInspect={setActiveItemId}
                          onToggle={(item, checked) => {
                            setSelectedIds((current) => {
                              const next = new Set(current);
                              if (checked) next.add(item.id);
                              else next.delete(item.id);
                              return next;
                            });
                          }}
                          selectedIds={selectedIds}
                        />
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t bg-background/70 px-3 py-2">
                  <span className="mr-auto text-muted-foreground text-sm">
                    {selectedCount} selected · {applicableItems.length} applyable
                  </span>
                  <Button
                    disabled={!selectedAgent?.from || previewState.isLoading}
                    onClick={() => void refreshPreview()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <HugeiconsIcon
                      className={previewState.isLoading ? 'animate-spin' : undefined}
                      icon={Refresh01Icon}
                    />
                    Refresh preview
                  </Button>
                  <Button
                    disabled={selectedCount === 0 || applyState.isLoading}
                    onClick={() => void applySelected()}
                    size="sm"
                    type="button"
                  >
                    Apply selected
                  </Button>
                </div>
              </div>

              <ImportInspector
                agent={selectedAgent}
                item={activeItem}
                onToggle={(checked) => {
                  if (!activeItem || !isApplicableItem(activeItem)) return;
                  setSelectedIds((current) => {
                    const next = new Set(current);
                    if (checked) next.add(activeItem.id);
                    else next.delete(activeItem.id);
                    return next;
                  });
                }}
                selected={activeItem ? selectedIds.has(activeItem.id) : false}
              />
            </section>
          </div>
        </div>
      </PanelShellBody>
    </PanelShell>
  );
}

function AgentButton({ agent, active, onSelect }: { agent: DetectedAgent; active: boolean; onSelect: () => void }) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        'grid min-h-16 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors',
        active ? 'border-primary/40 bg-primary/5' : 'border-transparent hover:bg-muted/50'
      )}
      onClick={onSelect}
      type="button"
    >
      <SourceIcon
        label={agent.label}
        source={agent.source}
      />
      <span className="min-w-0">
        <span className="block truncate font-medium text-sm">{agent.label}</span>
        <span className="block truncate text-muted-foreground text-xs">{agent.importPath}</span>
      </span>
      <span className="flex flex-col items-end gap-1">
        <Badge
          className="text-[10px]"
          variant={agent.from ? 'secondary' : 'outline'}
        >
          {agent.from ? 'importable' : 'read-only'}
        </Badge>
        <span className="text-[11px] text-muted-foreground">{agent.items.length} resources</span>
      </span>
    </button>
  );
}

function ImportHeader({
  agent,
  itemCount,
  loading,
  onRefresh
}: {
  agent: DetectedAgent | null;
  itemCount: number;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="border-b p-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          {agent ? (
            <SourceIcon
              label={agent.label}
              source={agent.source}
            />
          ) : null}
          <div className="min-w-0">
            <h3 className="truncate font-semibold text-sm">{agent?.label ?? 'Select an agent'}</h3>
            <p className="mt-0.5 truncate text-muted-foreground text-xs">{agent?.importPath ?? 'No agent selected'}</p>
          </div>
        </div>
        <Badge
          className="text-[10px]"
          variant="outline"
        >
          {loading ? 'previewing' : `${itemCount} preview items`}
        </Badge>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <ProvenanceBox
          title="Detected source"
          value={agent?.importPath ?? '—'}
        />
        <div className="hidden items-center text-muted-foreground text-xs md:flex">→</div>
        <ProvenanceBox
          title="Monad target"
          value="Local config, skills, agents, and MCP registry"
        />
      </div>

      {agent?.from ? (
        <div className="mt-3">
          <Button
            disabled={loading}
            onClick={onRefresh}
            size="sm"
            type="button"
            variant="ghost"
          >
            <HugeiconsIcon
              className={loading ? 'animate-spin' : undefined}
              icon={Refresh01Icon}
            />
            Rebuild preview
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ProvenanceBox({ title, value }: { title: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border bg-background px-3 py-2">
      <div className="font-medium text-[11px] text-muted-foreground">{title}</div>
      <div className="mt-0.5 truncate text-xs">{value}</div>
    </div>
  );
}

function ImportCategory({
  label,
  items,
  selectedIds,
  activeItemId,
  onToggle,
  onInspect
}: {
  label: string;
  items: ImportSettingsItem[];
  selectedIds: Set<string>;
  activeItemId: string | null;
  onToggle: (item: ImportSettingsItem, checked: boolean) => void;
  onInspect: (id: string) => void;
}) {
  return (
    <section className="rounded-md border bg-background">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="font-medium text-sm">{label}</span>
        <span className="text-muted-foreground text-xs">{items.length}</span>
      </div>
      <div className="divide-y">
        {items.map((item) => {
          const applyable = isApplicableItem(item);
          return (
            <div
              className={cn(
                'grid grid-cols-[1.75rem_minmax(0,1fr)] gap-2 px-3 py-2.5',
                activeItemId === item.id && 'bg-primary/5'
              )}
              key={item.id}
            >
              <input
                aria-label={`Include ${item.target}`}
                checked={selectedIds.has(item.id)}
                className="mt-1 size-4 accent-primary disabled:opacity-40"
                disabled={!applyable}
                onChange={(event) => onToggle(item, event.currentTarget.checked)}
                type="checkbox"
              />
              <button
                className="min-w-0 text-left"
                onClick={() => onInspect(item.id)}
                type="button"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="min-w-0 truncate font-medium text-sm">{item.target}</span>
                  <ToneChip tone={ACTION_TONE[item.action]}>{item.action}</ToneChip>
                  <ToneChip tone={RISK_TONE[item.risk]}>{item.risk}</ToneChip>
                </div>
                <p className="mt-1 line-clamp-2 text-muted-foreground text-xs">{item.reason}</p>
                {item.summary ? <p className="mt-1 truncate text-xs">{item.summary}</p> : null}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ImportInspector({
  agent,
  item,
  selected,
  onToggle
}: {
  agent: DetectedAgent | null;
  item: ImportSettingsItem | null;
  selected: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const applyable = item ? isApplicableItem(item) : false;
  return (
    <aside className="flex min-h-0 flex-col rounded-md border bg-card">
      <div className="border-b px-3 py-2">
        <h3 className="font-semibold text-sm">Inspector</h3>
        <p className="text-muted-foreground text-xs">Source, target, risk, and inclusion for the focused item.</p>
      </div>
      {item ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
          <div>
            <div className="text-muted-foreground text-xs">Resource</div>
            <div className="mt-1 font-medium text-sm">{item.target}</div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <InspectorFact
              label="Action"
              value={item.action}
            />
            <InspectorFact
              label="Risk"
              value={item.risk}
            />
          </div>
          <InspectorFact
            label="Category"
            value={CATEGORY_LABELS[item.category] ?? item.category}
          />
          <InspectorFact
            label="Source"
            value={item.source}
          />
          <InspectorFact
            label="Agent"
            value={agent?.label ?? '—'}
          />
          <div>
            <div className="text-muted-foreground text-xs">Reason</div>
            <p className="mt-1 text-sm leading-5">{item.reason}</p>
          </div>
          {item.summary ? (
            <div>
              <div className="text-muted-foreground text-xs">Summary</div>
              <p className="mt-1 text-sm leading-5">{item.summary}</p>
            </div>
          ) : null}
          <label className="mt-auto flex items-start gap-2 rounded-md border bg-background p-3">
            <input
              checked={selected}
              className="mt-0.5 size-4 accent-primary disabled:opacity-40"
              disabled={!applyable}
              onChange={(event) => onToggle(event.currentTarget.checked)}
              type="checkbox"
            />
            <span>
              <span className="block font-medium text-sm">Include this item</span>
              <span className="block text-muted-foreground text-xs">
                {applyable
                  ? 'Not selected by default. Include only after review.'
                  : 'This item cannot be applied automatically.'}
              </span>
            </span>
          </label>
        </div>
      ) : (
        <EmptyReview message="Focus a preview item to inspect import details." />
      )}
    </aside>
  );
}

function InspectorFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border bg-background px-2.5 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-xs">{value}</div>
    </div>
  );
}

function EmptyReview({ message }: { message: string }) {
  return (
    <div className="flex min-h-36 items-center justify-center px-6 text-center text-muted-foreground text-sm">
      {message}
    </div>
  );
}

function ToneChip({ tone, children }: { tone: string; children: string }) {
  return <span className={cn('rounded-full border px-2 py-0.5 font-medium text-[10px]', tone)}>{children}</span>;
}

function detectedAgents(roots: CapabilityInventoryRoot[], items: CapabilityInventoryItem[]): DetectedAgent[] {
  const grouped = new Map<string, CapabilityInventoryRoot[]>();
  for (const root of roots) {
    if (!root.exists || root.source === 'monad' || !IMPORTABLE_SOURCES.has(root.source)) continue;
    const key = `${root.source}:${root.sourceLabel}`;
    grouped.set(key, [...(grouped.get(key) ?? []), root]);
  }
  return Array.from(grouped.entries()).map(([key, productRoots]) => {
    const source = productRoots[0]?.source;
    const sourceLabel = productRoots[0]?.sourceLabel;
    const productItems = items.filter((item) =>
      productRoots.some(
        (root) => item.source === root.source && item.sourceLabel === root.sourceLabel && item.scope === root.scope
      )
    );
    return {
      key,
      label: sourceLabel,
      source,
      from: importSourceFor(source, sourceLabel),
      importPath: importPathForRoots(productRoots),
      roots: productRoots,
      items: productItems,
      counts: {
        agent: productItems.filter((item) => item.kind === 'agent').length,
        skill: productItems.filter((item) => item.kind === 'skill').length,
        mcpServer: productItems.filter((item) => item.kind === 'mcpServer').length,
        modelProvider: productItems.filter((item) => item.kind === 'modelProvider').length
      }
    };
  });
}

function importSourceFor(source: CapabilityInventorySource, label: string): ImportSettingsSource | null {
  if (source === 'claude-code' && /desktop/i.test(label)) return 'claude-desktop';
  if (source === 'codex') return 'codex';
  if (source === 'claude-code') return 'claude-code';
  if (source === 'cursor') return 'cursor';
  if (source === 'hermes') return 'hermes';
  if (source === 'openclaw') return 'openclaw';
  if (source === 'vscode') return 'vscode';
  return null;
}

function importPathForRoots(roots: CapabilityInventoryRoot[]): string {
  const bases = roots.map((root) => baseImportPath(root));
  const counts = new Map<string, number>();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);
  return (
    Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ??
    roots[0]?.path ??
    ''
  );
}

function baseImportPath(root: CapabilityInventoryRoot): string {
  const name = pathBaseName(root.path);
  if ((root.kind === 'skills' && name === 'skills') || (root.kind === 'agents' && name === 'agents'))
    return pathDirName(root.path);
  if (root.kind === 'mcpServers' && (isConfigFileName(name) || name === 'mcp')) return pathDirName(root.path);
  return root.path;
}

function isConfigFileName(name: string): boolean {
  return /^(settings|config|mcp|claude_desktop_config)\.(json|toml|ya?ml)$/i.test(name);
}

function pathBaseName(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts.at(-1) ?? path;
}

function pathDirName(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function groupImportItems(items: ImportSettingsItem[]): Array<[string, ImportSettingsItem[]]> {
  const groups = new Map<string, ImportSettingsItem[]>();
  for (const item of items) groups.set(item.category, [...(groups.get(item.category) ?? []), item]);
  return Array.from(groups.entries());
}

function isApplicableItem(item: ImportSettingsItem): boolean {
  return item.action === 'add' || item.action === 'update';
}

function productIconForSource(source: CapabilityInventorySource): ProductIconId | undefined {
  if (source === 'codex') return 'codex';
  if (source === 'claude-code') return 'claude-code';
  if (source === 'gemini') return 'gemini';
  if (source === 'qwen') return 'qwen';
  if (source === 'openclaw') return 'openclaw';
  if (source === 'hermes') return 'hermes';
  return undefined;
}

function SourceIcon({ source, label }: { source: CapabilityInventorySource; label: string }) {
  const product = productIconForSource(source);
  if (product) {
    return (
      <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-background">
        <ProductIcon
          background="none"
          className="size-4"
          product={product}
        />
      </span>
    );
  }
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-background font-semibold text-[10px]">
      {label
        .split(/\s+/)
        .map((part) => part[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()}
    </span>
  );
}
