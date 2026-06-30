'use client';

import type { SkillListInstance } from '@monad/protocol';
import type { Panel, SkillEditorState } from './types';

import {
  useGetSkillsSettingsQuery,
  useLazyCheckSkillUpdatesQuery,
  useListInstalledSkillsQuery,
  useListSkillsQuery,
  useSetSkillsSettingsMutation,
  useUploadSkillMutation
} from '@monad/client-rtk';
import { Badge, Button, cn, ScrollArea, Switch, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';
import {
  ArrowLeft,
  ArrowUpCircle,
  BookOpenText,
  Loader2,
  Plus,
  Shield,
  Sparkles,
  SquarePen,
  Store,
  Upload
} from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { isSkillMarketplacePath, skillMarketplacePath, studioPath } from '@/components/routes/route-paths';
import { toast } from '@/components/ToastProvider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { useMonadRuntime } from '@/lib/monad-runtime-provider';
import { StudioPanel, StudioPanelHeader } from '../StudioPanel';
import { BrowsePanel } from './BrowsePanel';
import { GitHubMark } from './GitHubMark';
import { GithubInstallDialog } from './GithubInstallDialog';
import { InlineHelpHover } from './InlineHelpHover';
import { SkillCard, SkillSection } from './SkillCard';
import { SkillEditorDialog } from './SkillEditorDialog';
import { InstalledSkillsSkeleton } from './skeletons';
import { UploadSkillDialog } from './UploadSkillDialog';
import { loadSkillContent, sortSkillInstancesByName } from './utils';

export function SkillsSettings({ onClose: _onClose }: { onClose: () => void }) {
  const t = useT();
  const pathname = usePathname();
  const router = useRouter();
  const { client: monadClient } = useMonadRuntime();
  const { data, isFetching, refetch } = useListInstalledSkillsQuery();
  const { data: liveSkillsData, refetch: refetchLiveSkills } = useListSkillsQuery({ scope: ['global', 'atom-pack'] });
  const { data: settings, isFetching: loadingSettings } = useGetSkillsSettingsQuery();
  const [setSkillsSettings] = useSetSkillsSettingsMutation();
  const [uploadSkill, { isLoading: uploading }] = useUploadSkillMutation();
  // Lazy: the update check hits github once per installed skill, so it only runs when the user asks
  // (the button) — opening the panel costs zero github calls.
  const [checkUpdates, { data: updatesData, isFetching: checking }] = useLazyCheckSkillUpdatesQuery();
  const updates = updatesData?.updates ?? [];
  const [adding, setAdding] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [editor, setEditor] = useState<SkillEditorState | null>(null);
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [pendingSettingsControl, setPendingSettingsControl] = useState<'global' | string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [panel, setPanel] = useState<Panel>(() => (isSkillMarketplacePath(pathname) ? 'browse' : 'installed'));
  const skills = data?.skills ?? [];
  const installedSkillByName = useMemo(() => new Map(skills.map((skill) => [skill.name, skill])), [skills]);
  const skillInstances = liveSkillsData?.skillInstances ?? [];
  const autoload = settings?.autoload ?? true;
  const installReview = settings?.installReview ?? false;
  const installReviewAvailable = settings?.installReviewAvailable ?? false;
  const disabledSkills = settings?.disabled ?? [];
  const autoloadDisabledSkills = settings?.autoloadDisabled ?? [];
  const disabledSkillSet = useMemo(() => new Set(disabledSkills), [disabledSkills]);
  const autoloadDisabledSkillSet = useMemo(() => new Set(autoloadDisabledSkills), [autoloadDisabledSkills]);
  const globalSkillInstances = useMemo(
    () => sortSkillInstancesByName(skillInstances.filter((skill) => skill.sourceKind === 'global')),
    [skillInstances]
  );
  const atomPackSkillInstances = useMemo(
    () => sortSkillInstancesByName(skillInstances.filter((skill) => skill.sourceKind === 'atom-pack')),
    [skillInstances]
  );
  const enabledCount = skillInstances.filter((skill) => skill.available && !disabledSkillSet.has(skill.id)).length;

  useEffect(() => {
    if (isSkillMarketplacePath(pathname)) setPanel('browse');
  }, [pathname]);

  const refreshSkills = async () => {
    await Promise.all([refetch(), refetchLiveSkills()]);
  };

  const handleCheckUpdates = async () => {
    const result = await checkUpdates()
      .unwrap()
      .catch(() => null);
    if (!result) {
      toast.error(t('web.skills.updateCheckFailed'));
      return;
    }
    const updateCount = result.updates.filter((update) => update.hasUpdate).length;
    toast[updateCount > 0 ? 'success' : 'info'](
      updateCount > 0 ? t('web.skills.updateCheckFound', { count: updateCount }) : t('web.skills.updateCheckNone')
    );
  };

  const handleAutoloadChange = (checked: boolean) => {
    setPendingSettingsControl('global');
    void setSkillsSettings({ autoload: checked })
      .unwrap()
      .catch(() => {})
      .finally(() => setPendingSettingsControl(null));
  };

  const handleInstallReviewChange = (checked: boolean) => {
    setPendingSettingsControl('install-review');
    void setSkillsSettings({ installReview: checked })
      .unwrap()
      .catch(() => {})
      .finally(() => setPendingSettingsControl(null));
  };

  const handleSkillEnabledChange = (id: string, checked: boolean) => {
    const next = checked ? disabledSkills.filter((skillId) => skillId !== id) : [...new Set([...disabledSkills, id])];
    setPendingSettingsControl(`enabled:${id}`);
    void setSkillsSettings({ disabled: next })
      .unwrap()
      .catch(() => {})
      .finally(() => setPendingSettingsControl(null));
  };

  const handleSkillAutoloadChange = (id: string, checked: boolean) => {
    const next = checked
      ? autoloadDisabledSkills.filter((skillId) => skillId !== id)
      : [...new Set([...autoloadDisabledSkills, id])];
    setPendingSettingsControl(`autoload:${id}`);
    void setSkillsSettings({ autoloadDisabled: next })
      .unwrap()
      .catch(() => {})
      .finally(() => setPendingSettingsControl(null));
  };

  const handleUploadFile = async (file: File | undefined) => {
    if (!file) return;
    const res = await uploadSkill({
      filename: file.name,
      body: file,
      contentType: file.type || 'application/octet-stream',
      overwrite: true
    })
      .unwrap()
      .catch(() => null);
    if (!res) {
      toast.error(t('web.skills.uploadFailed'));
      return;
    }
    setUploadDialogOpen(false);
    await refreshSkills();
  };

  const handleEditSkill = async (skill: SkillListInstance) => {
    setEditError(null);
    setEditingSkillId(skill.id);
    const res = await loadSkillContent(skill, monadClient).catch(() => null);
    if (res) setEditor({ id: skill.id, name: res.name, title: skill.name, content: res.content, files: res.files });
    else setEditError(t('web.skills.loadContentFailed'));
    setEditingSkillId(null);
  };

  const renderAutoloadHelp = () => (
    <InlineHelpHover
      body={t('web.skills.autoloadHelpBody')}
      icon={<BookOpenText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
      label={t('web.skills.autoloadHelp')}
      sections={[t('web.skills.autoloadHelpOff'), t('web.skills.autoloadHelpPerSkill')]}
      title={t('web.skills.autoloadHelpTitle')}
    />
  );

  const renderInstallReviewHelp = () => (
    <InlineHelpHover
      body={t('web.skills.installReviewHelpBody')}
      icon={<Shield className="mt-0.5 size-4 shrink-0" />}
      label={t('web.skills.installReviewHelp')}
      sections={[t('web.skills.installReviewHelpConfirm'), t('web.skills.installReviewHelpUnavailable')]}
      title={t('web.skills.installReviewHelpTitle')}
    />
  );

  const renderSettingsControl = (kind: 'autoload' | 'review', density: 'card' | 'row' | 'compact' = 'row') => {
    const isAutoload = kind === 'autoload';
    const title = isAutoload ? t('web.skills.autoloadTitle') : t('web.skills.installReviewTitle');
    const hint = isAutoload
      ? t('web.skills.autoloadHint')
      : installReviewAvailable
        ? t('web.skills.installReviewHint')
        : t('web.skills.installReviewUnavailableHint');
    const Icon = isAutoload ? BookOpenText : Shield;
    const help = isAutoload ? renderAutoloadHelp() : renderInstallReviewHelp();
    const control = (
      <Switch
        aria-label={title}
        checked={isAutoload ? autoload : installReview && installReviewAvailable}
        disabled={
          isAutoload
            ? loadingSettings || pendingSettingsControl === 'global'
            : !installReviewAvailable || loadingSettings || pendingSettingsControl === 'install-review'
        }
        onCheckedChange={isAutoload ? handleAutoloadChange : handleInstallReviewChange}
      />
    );

    if (density === 'card') {
      return (
        <div className="rounded-lg border bg-card p-4">
          <div className="flex h-full flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <Icon className={cn('size-4 shrink-0', isAutoload && 'text-muted-foreground')} />
                <h3 className="min-w-0 flex-1 text-wrap font-medium text-sm">{title}</h3>
              </div>
              <div className="inline-flex max-w-[68ch] flex-wrap items-center gap-x-1 text-muted-foreground text-sm">
                <span className="leading-5">{hint}</span>
                {help}
              </div>
            </div>
            <div className="flex items-center">{control}</div>
          </div>
        </div>
      );
    }

    if (density === 'compact') {
      return (
        <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border bg-card/60 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Icon className={cn('size-4 shrink-0', isAutoload && 'text-muted-foreground')} />
            <span className="min-w-0 truncate font-medium text-sm">{title}</span>
            {help}
          </div>
          {control}
        </div>
      );
    }

    return (
      <div className="flex min-w-0 items-center justify-between gap-4 border-b py-3 last:border-b-0">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Icon className={cn('size-4 shrink-0', isAutoload && 'text-muted-foreground')} />
            <span className="min-w-0 truncate font-medium text-sm">{title}</span>
            {help}
          </div>
          <p className="mt-0.5 line-clamp-1 text-muted-foreground text-xs">{hint}</p>
        </div>
        {control}
      </div>
    );
  };

  const renderSettingsCards = () => (
    <div className="grid gap-3 lg:grid-cols-2">
      {renderSettingsControl('autoload', 'card')}
      {renderSettingsControl('review', 'card')}
    </div>
  );

  const renderSettingsRows = () => (
    <div className="rounded-lg border bg-card/60 px-4">
      {renderSettingsControl('autoload')}
      {renderSettingsControl('review')}
    </div>
  );

  const renderSettingsCompact = () => (
    <div className="grid gap-2 lg:grid-cols-2">
      {renderSettingsControl('autoload', 'compact')}
      {renderSettingsControl('review', 'compact')}
    </div>
  );

  const renderSkillSections = () =>
    skillInstances.length > 0 ? (
      <>
        <SkillSection title={t('web.skills.globalSection')}>
          {globalSkillInstances.map((s) => (
            <SkillCard
              autoload={autoload}
              autoloadDisabled={autoloadDisabledSkillSet.has(s.id)}
              autoloadDisabledControl={loadingSettings || pendingSettingsControl === `autoload:${s.id}`}
              disabled={disabledSkillSet.has(s.id)}
              disabledControl={loadingSettings || pendingSettingsControl === `enabled:${s.id}`}
              editing={editingSkillId === s.id}
              installed={installedSkillByName.get(s.name)}
              key={s.id}
              onAutoloadChange={(checked) => handleSkillAutoloadChange(s.id, checked)}
              onEdit={() => void handleEditSkill(s)}
              onEnabledChange={(checked) => handleSkillEnabledChange(s.id, checked)}
              skill={s}
              update={updates.find((u) => u.name === s.name)}
            />
          ))}
        </SkillSection>
        <SkillSection title={t('web.skills.atomPackSection')}>
          {atomPackSkillInstances.map((s) => (
            <SkillCard
              autoload={autoload}
              autoloadDisabled={autoloadDisabledSkillSet.has(s.id)}
              autoloadDisabledControl={loadingSettings || pendingSettingsControl === `autoload:${s.id}`}
              disabled={disabledSkillSet.has(s.id)}
              disabledControl={loadingSettings || pendingSettingsControl === `enabled:${s.id}`}
              editing={editingSkillId === s.id}
              key={s.id}
              onAutoloadChange={(checked) => handleSkillAutoloadChange(s.id, checked)}
              onEdit={() => void handleEditSkill(s)}
              onEnabledChange={(checked) => handleSkillEnabledChange(s.id, checked)}
              skill={s}
            />
          ))}
        </SkillSection>
      </>
    ) : null;

  const renderInstalledStatus = () => (
    <>
      {adding ? (
        <GithubInstallDialog
          onCancel={() => setAdding(false)}
          onInstalled={async () => {
            setAdding(false);
            await refreshSkills();
          }}
        />
      ) : null}

      {editError ? <p className="text-destructive text-xs">{editError}</p> : null}

      {(isFetching || loadingSettings) && skillInstances.length === 0 ? <InstalledSkillsSkeleton /> : null}

      {skillInstances.length === 0 && !adding && !(isFetching || loadingSettings) ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <Sparkles className="size-7 text-muted-foreground" />
          <p className="font-medium text-sm">{t('web.skills.empty')}</p>
          <p className="max-w-sm text-muted-foreground text-sm">{t('web.skills.emptyHint')}</p>
          <Button
            className="mt-1"
            onClick={() => setAdding(true)}
            size="sm"
          >
            <Plus className="size-3.5" />
            {t('web.skills.add')}
          </Button>
        </div>
      ) : null}
    </>
  );

  const renderInstalledPanelVariant = (variant: 'rows' | 'list-first' | 'cards' | 'rail') => {
    if (variant === 'rail') {
      return (
        <div className="grid min-h-full gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-4">
            {renderInstalledStatus()}
            {renderSkillSections()}
          </div>
          <aside className="flex min-w-0 flex-col gap-2 xl:sticky xl:top-4 xl:self-start">
            {renderSettingsControl('autoload', 'compact')}
            {renderSettingsControl('review', 'compact')}
          </aside>
        </div>
      );
    }

    if (variant === 'list-first') {
      return (
        <div className="flex flex-col gap-4 p-4">
          {renderInstalledStatus()}
          {renderSkillSections()}
          {renderSettingsCompact()}
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-4 p-4">
        {variant === 'cards' ? renderSettingsCards() : renderSettingsRows()}
        {renderInstalledStatus()}
        {renderSkillSections()}
      </div>
    );
  };

  return (
    <StudioPanel>
      <StudioPanelHeader
        actions={
          <>
            {panel === 'installed' ? (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">
                      <Button
                        aria-label={t('web.skills.checkUpdates')}
                        className="size-7"
                        disabled={checking}
                        onClick={() => void handleCheckUpdates()}
                        size="icon"
                        variant="ghost"
                      >
                        <ArrowUpCircle className={cn(checking && 'animate-pulse text-foreground')} />
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{t('web.skills.checkUpdates')}</TooltipContent>
                </Tooltip>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      aria-label={t('web.skills.add')}
                      className="size-7"
                      disabled={uploading}
                      size="icon"
                      variant="ghost"
                    >
                      {uploading ? <Loader2 className="animate-spin" /> : <Plus />}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setAdding(true)}>
                      <GitHubMark className="size-4" />
                      {t('web.skills.addGithub')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setUploadDialogOpen(true)}>
                      <Upload className="size-4" />
                      {t('web.skills.addUpload')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setEditor({ content: '' })}>
                      <SquarePen className="size-4" />
                      {t('web.skills.addEditor')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : null}
            <Button
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => {
                const next = panel === 'browse' ? 'installed' : 'browse';
                setPanel(next);
                setAdding(false);
                router.replace(next === 'browse' ? skillMarketplacePath() : studioPath('skills'));
              }}
              size="sm"
              variant="ghost"
            >
              {panel === 'browse' ? <ArrowLeft className="size-3.5" /> : <Store className="size-3.5" />}
              {panel === 'browse' ? t('web.skills.installedList') : t('web.skills.marketplace')}
            </Button>
          </>
        }
        badge={
          <Badge
            className="h-5 px-1.5 text-[10px]"
            variant="secondary"
          >
            {t('web.skills.enabledCount', { enabled: enabledCount, total: skillInstances.length })}
          </Badge>
        }
        subtitle={t('web.skills.subtitle')}
        title={t('web.skills.title')}
      />

      <input
        accept=".md,.zip,.skill,text/markdown,application/zip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.currentTarget.value = '';
          void handleUploadFile(file);
        }}
        ref={fileInputRef}
        type="file"
      />

      {panel === 'browse' ? (
        <BrowsePanel
          onInstalled={async () => {
            await refreshSkills();
          }}
          onInstallFailed={() => toast.error(t('web.skills.installFailed'))}
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">{renderInstalledPanelVariant('rail')}</ScrollArea>
      )}
      <SkillEditorDialog
        editor={editor}
        onClose={() => setEditor(null)}
        onSaved={() => {
          setEditor(null);
          void refreshSkills();
        }}
      />
      <UploadSkillDialog
        inputRef={fileInputRef}
        loading={uploading}
        onClose={() => setUploadDialogOpen(false)}
        onFile={(file) => void handleUploadFile(file)}
        open={uploadDialogOpen}
      />
    </StudioPanel>
  );
}
