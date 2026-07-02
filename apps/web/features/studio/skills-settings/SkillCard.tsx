import type { InstalledSkill, SkillListInstance, SkillUpdate } from '@monad/protocol';
import type { ReactNode } from 'react';

import {
  BoxIcon,
  CalendarDaysIcon,
  CircleSlash2Icon,
  Delete02Icon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitForkIcon,
  LoaderPinwheelIcon,
  PencilEdit01Icon,
  SquareArrowUp01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useRemoveSkillMutation, useUpdateSkillMutation } from '@monad/client-rtk';
import { Badge, Button, cn, Switch, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';
import { useState } from 'react';

import { HoverActions } from '@/components/HoverActions';
import { useT } from '@/components/I18nProvider';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { renderableIconText } from '@/lib/renderable-icon-text';
import { GitHubMark } from './GitHubMark';
import { formatDate, githubRefKind, githubRepositoryHref, githubSourceDetails, isHttpIcon } from './utils';

export function SkillSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h3 className="shrink-0 font-medium text-muted-foreground text-xs">{title}</h3>
        <div className="h-px flex-1 bg-border/80" />
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] items-stretch gap-3">
        {children}
      </div>
    </section>
  );
}

function atomPackName(skill: SkillListInstance): string | null {
  if (skill.sourceKind !== 'atom-pack') return null;
  for (const value of [skill.source, skill.sourceId, skill.id]) {
    if (value.startsWith('Atom Pack:')) return value.slice('Atom Pack:'.length).trim();
    const atomPackMarker = 'atom-pack:';
    const index = value.indexOf(atomPackMarker);
    if (index >= 0) return value.slice(index + atomPackMarker.length).split(':')[0] ?? null;
  }
  return null;
}

function GitHubMetadataRow({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[1rem_5.5rem_minmax(0,1fr)] items-start gap-2 text-[11px] leading-5">
      <span className="mt-0.5 grid size-4 place-items-center text-muted-foreground">{icon}</span>
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all font-mono text-popover-foreground">{value}</span>
    </div>
  );
}

function GitHubRepositoryRow({ address, label, openLabel }: { address: string; label: string; openLabel: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[1rem_5.5rem_minmax(0,1fr)] items-center gap-2 text-[11px] leading-5">
      <span className="grid size-4 place-items-center text-muted-foreground">
        <GitHubMark className="size-3" />
      </span>
      <span className="text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className="min-w-0 truncate font-mono text-popover-foreground"
          title={address}
        >
          {address}
        </span>
        <a
          aria-label={openLabel}
          className="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          href={githubRepositoryHref(address)}
          rel="noreferrer"
          target="_blank"
        >
          <HugeiconsIcon
            className="size-3"
            icon={ExternalLinkIcon}
          />
        </a>
      </span>
    </div>
  );
}

export function SkillCard({
  skill,
  installed,
  update,
  autoload,
  disabled,
  autoloadDisabled,
  disabledControl,
  autoloadDisabledControl,
  onEdit,
  editing,
  onEnabledChange,
  onAutoloadChange
}: {
  skill: SkillListInstance;
  installed?: InstalledSkill;
  update?: SkillUpdate;
  autoload: boolean;
  disabled: boolean;
  autoloadDisabled: boolean;
  disabledControl: boolean;
  autoloadDisabledControl: boolean;
  onEdit: () => void;
  editing?: boolean;
  onEnabledChange: (checked: boolean) => void;
  onAutoloadChange: (checked: boolean) => void;
}) {
  const t = useT();
  const [remove, { isLoading: removing }] = useRemoveSkillMutation();
  const [updateSkill, { isLoading: updating }] = useUpdateSkillMutation();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const hasUpdate = update?.hasUpdate ?? false;
  const available = skill.available;
  const skillEnabled = !disabled;
  const skillAutoloadEnabled = skillEnabled && !autoloadDisabled;
  const installedAt = formatDate(installed?.installedAt);
  const githubSource = githubSourceDetails(installed?.source);
  const githubRef = githubSource?.ref ?? 'main';
  const githubRefKindValue = githubRefKind(githubSource?.ref);
  const canManageInstalled = skill.sourceKind === 'global';
  const version = skill.version ?? installed?.version;
  const icon = skill.icon ?? installed?.icon;
  const textIcon = renderableIconText(icon);
  const packName = atomPackName(skill);
  const pillClass = 'px-1.5 py-0 text-[9px] leading-3';
  const keepActionsVisible = Boolean(confirmRemove || removing || updating || editing);
  const renderSkillCard = ({
    article,
    body,
    iconBox,
    description,
    controls
  }: {
    article: string;
    body: string;
    controls: string;
    description: string;
    iconBox: string;
  }) => (
    <article className={article}>
      <div className={body}>
        <div className={iconBox}>
          {isHttpIcon(icon) ? (
            <span
              className="size-full bg-center bg-cover"
              style={{ backgroundImage: `url("${encodeURI(icon ?? '').replace(/"/g, '%22')}")` }}
            />
          ) : textIcon ? (
            <span className="truncate px-1">{textIcon}</span>
          ) : (
            <HugeiconsIcon
              className="size-4 text-muted-foreground"
              icon={BoxIcon}
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5">
                {githubSource ? (
                  <HoverCard openDelay={150}>
                    <HoverCardTrigger asChild>
                      <button
                        aria-label={t('web.skills.githubMetadata')}
                        className="grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        type="button"
                      >
                        <GitHubMark className="size-3.5" />
                      </button>
                    </HoverCardTrigger>
                    <HoverCardContent
                      align="start"
                      className="w-80 p-3"
                    >
                      <div className="flex flex-col gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <GitHubMark className="size-4 shrink-0" />
                          <div className="min-w-0">
                            <div className="truncate font-medium text-sm">{skill.name}</div>
                          </div>
                        </div>
                        <div className="flex flex-col gap-1 border-t pt-2">
                          <GitHubRepositoryRow
                            address={githubSource.address}
                            label={t('web.skills.githubRepository')}
                            openLabel={t('web.skills.openGithubRepository')}
                          />
                          <GitHubMetadataRow
                            icon={
                              githubRefKindValue === 'main' ? (
                                <HugeiconsIcon
                                  className="size-3"
                                  icon={GitForkIcon}
                                />
                              ) : (
                                <HugeiconsIcon
                                  className="size-3"
                                  icon={GitBranchIcon}
                                />
                              )
                            }
                            label={t('web.skills.githubRef')}
                            value={githubRef}
                          />
                          {installed?.commit ? (
                            <GitHubMetadataRow
                              icon={
                                <HugeiconsIcon
                                  className="size-3"
                                  icon={GitCommitIcon}
                                />
                              }
                              label={t('web.skills.githubCommit')}
                              value={installed.commit.slice(0, 7)}
                            />
                          ) : null}
                          {installedAt ? (
                            <GitHubMetadataRow
                              icon={
                                <HugeiconsIcon
                                  className="size-3"
                                  icon={CalendarDaysIcon}
                                />
                              }
                              label={t('web.skills.githubInstalledAt')}
                              value={<span className="font-sans">{installedAt}</span>}
                            />
                          ) : null}
                        </div>
                      </div>
                    </HoverCardContent>
                  </HoverCard>
                ) : null}
                <h3 className="min-w-0 truncate font-medium text-sm leading-5">{skill.name}</h3>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {version ? (
                  <Badge
                    className={pillClass}
                    variant="outline"
                  >
                    v{version}
                  </Badge>
                ) : null}
                {packName ? (
                  <Badge
                    className={cn('max-w-full gap-1', pillClass)}
                    variant="outline"
                  >
                    <span className="text-muted-foreground">{t('web.skills.from')}</span>
                    <span className="min-w-0 truncate">{packName}</span>
                  </Badge>
                ) : null}
                {!available ? (
                  <Badge
                    className={cn('gap-1', pillClass)}
                    variant="outline"
                  >
                    <HugeiconsIcon
                      className="size-3 text-muted-foreground"
                      icon={CircleSlash2Icon}
                    />
                    {t('web.skills.unavailable')}
                  </Badge>
                ) : null}
              </div>
            </div>
            <HoverActions
              className="gap-1 duration-150 ease-out"
              data-slot="skill-card-actions"
              visible={keepActionsVisible}
            >
              {canManageInstalled && hasUpdate ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">
                      <Button
                        className="h-7 gap-1 px-2"
                        disabled={updating}
                        onClick={() =>
                          void updateSkill({ name: skill.name, consent: true })
                            .unwrap()
                            .catch(() => {})
                        }
                        size="sm"
                        variant="secondary"
                      >
                        {updating ? (
                          <HugeiconsIcon
                            className="size-3.5 animate-spin text-foreground"
                            icon={LoaderPinwheelIcon}
                          />
                        ) : (
                          <HugeiconsIcon
                            className="size-3.5"
                            icon={SquareArrowUp01Icon}
                          />
                        )}
                        {t('web.skills.update')}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{t('web.skills.update')}</TooltipContent>
                </Tooltip>
              ) : null}
              <Button
                aria-label={t('web.skills.edit')}
                className="size-7"
                disabled={editing}
                onClick={onEdit}
                size="icon"
                variant="ghost"
              >
                {editing ? (
                  <HugeiconsIcon
                    className="size-3.5 animate-spin text-foreground"
                    icon={LoaderPinwheelIcon}
                  />
                ) : (
                  <HugeiconsIcon
                    className="size-3.5"
                    icon={PencilEdit01Icon}
                  />
                )}
              </Button>
              {canManageInstalled ? (
                <Popover
                  onOpenChange={setConfirmRemove}
                  open={confirmRemove}
                >
                  <PopoverTrigger asChild>
                    <Button
                      aria-label={t('web.skills.remove')}
                      className="size-7"
                      size="icon"
                      variant="ghost"
                    >
                      <HugeiconsIcon
                        className="size-3.5"
                        icon={Delete02Icon}
                      />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    className="w-56"
                    side="bottom"
                  >
                    <div className="flex flex-col gap-3">
                      <div className="flex items-start gap-2">
                        <HugeiconsIcon
                          className="mt-0.5 size-4 shrink-0 text-destructive"
                          icon={Delete02Icon}
                        />
                        <div className="min-w-0">
                          <div className="font-medium text-sm">{t('web.skills.confirmRemove')}</div>
                        </div>
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button
                          disabled={removing}
                          onClick={() => setConfirmRemove(false)}
                          size="sm"
                          variant="ghost"
                        >
                          {t('web.cancel')}
                        </Button>
                        <Button
                          disabled={removing}
                          onClick={async () => {
                            await remove({ name: skill.name })
                              .unwrap()
                              .catch(() => {});
                            setConfirmRemove(false);
                          }}
                          size="sm"
                          variant="destructive"
                        >
                          {removing ? (
                            <HugeiconsIcon
                              className="size-3.5 animate-spin"
                              icon={LoaderPinwheelIcon}
                            />
                          ) : (
                            <HugeiconsIcon
                              className="size-3.5"
                              icon={Delete02Icon}
                            />
                          )}
                          {t('web.skills.remove')}
                        </Button>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              ) : null}
            </HoverActions>
          </div>
          <p className={description}>{skill.description || t('web.skills.noDescription')}</p>
        </div>
      </div>

      <div className={controls}>
        <div className="flex min-h-10 items-center justify-between gap-3 px-4 py-2 transition-[background-color,color] duration-150 ease-out hover:bg-accent/50">
          <span className="min-w-0 truncate text-xs">
            {skillEnabled ? t('web.skills.skillEnabled') : t('web.skills.skillDisabled')}
          </span>
          <Switch
            aria-label={t('web.skills.skillEnabledToggle', { name: skill.name })}
            checked={skillEnabled}
            disabled={disabledControl}
            onCheckedChange={onEnabledChange}
          />
        </div>
        <div className="flex min-h-10 items-center justify-between gap-3 border-t px-4 py-2 transition-[background-color,color] duration-150 ease-out hover:bg-accent/50 sm:border-t-0 sm:border-l">
          <span className="min-w-0 truncate text-xs">
            {autoload && skillAutoloadEnabled ? t('web.skills.contextEnabled') : t('web.skills.contextPaused')}
          </span>
          <Switch
            aria-label={t('web.skills.skillAutoloadToggle', { name: skill.name })}
            checked={autoload && skillAutoloadEnabled}
            disabled={!autoload || !skillEnabled || autoloadDisabledControl}
            onCheckedChange={onAutoloadChange}
          />
        </div>
      </div>
    </article>
  );

  return renderSkillCard({
    article: 'group flex h-full w-full flex-col overflow-hidden rounded-md border border-border/70 bg-card',
    body: 'flex min-w-0 flex-1 items-start gap-3 p-3',
    controls: 'grid gap-0 border-t bg-muted/10 sm:grid-cols-2',
    description: 'mt-2 line-clamp-3 text-muted-foreground text-xs leading-5',
    iconBox: 'grid size-8 shrink-0 place-items-center overflow-hidden rounded-md bg-muted/40 text-xs'
  });
}
