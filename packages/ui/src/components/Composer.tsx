import type { ComponentPropsWithoutRef, CSSProperties, ReactElement, ReactNode } from 'react';
import type { ComposerContextUsagePanelProps } from './composer/context-usage-panel';

import {
  CheckIcon,
  ChevronDownIcon,
  CornerDownLeftIcon,
  MagicWand02Icon,
  Mic01Icon,
  ShieldQuestionMarkIcon,
  SquareIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Fragment, forwardRef, useEffect, useId, useMemo, useRef, useState } from 'react';

import { cn } from '../lib/utils';
import { ChatInputChrome } from './ChatInput';
import { ComposerContextUsagePanel } from './composer/context-usage-panel';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from './DropdownMenu';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';
import { Tooltip, TooltipContent, TooltipTrigger } from './Tooltip';

export type { ComposerContextUsagePanelProps } from './composer/context-usage-panel';

export { ComposerContextUsagePanel } from './composer/context-usage-panel';

export type ComposerSurfaceProps = {
  accessoryLeftTools?: ReactNode;
  accessoryRightTools?: ReactNode;
  ariaBusy?: boolean;
  children: ReactNode;
  className?: string;
  leftTools?: ReactNode;
  liquidGlass?: boolean;
  mentionMenu?: ReactNode;
  mentionPreview?: ReactNode;
  rightTools?: ReactNode;
  voiceLevel?: number;
  voiceSpectrum?: number[];
  voiceState?: 'idle' | 'listening' | 'busy';
};

export type ComposerAccessoryItem = 'access' | 'usage' | 'model' | 'effort';

export type ComposerAccessoryControls = {
  access?: {
    ariaLabel?: string;
    askLabel: string;
    autoLabel: string;
    mode: ComposerAccessMode;
    onChange?: (mode: ComposerAccessMode) => void;
  };
  items?: ComposerAccessoryItem[];
  effort?: {
    ariaLabel?: string;
    control: ReactNode;
    current?: string;
    onOpenChange?: (open: boolean) => void;
  };
  model?: {
    ariaLabel?: string;
    currentEffort?: string;
    currentModel?: string;
    currentProvider?: string;
    onModelChange?: (provider: string, model: string) => void;
    onProviderChange?: (provider: string) => void;
    onUseProfile?: () => void;
    noModelsLabel?: string;
    placeholder?: string;
    profileDefault?: {
      effort?: string;
      label?: string;
      modelLabel?: string;
    };
    providers: ComposerModelProviderOption[];
    providersLabel?: string;
    searchModelsLabel?: string;
    useProfileLabel?: string;
  };
  profile?: {
    ariaLabel?: string;
    current?: string;
    currentModel?: string;
    onChange?: (profile: string) => void;
    onModelChange?: (profile: string, model: string) => void;
    options: { label: string; value: string }[];
    profiles?: ComposerProfileOption[];
    placeholder?: string;
  };
  usage?: {
    ariaLabel?: string;
    panel?: Omit<ComposerContextUsagePanelProps, 'percent'>;
    percent: number;
    title?: string;
    unavailableLabel?: string;
    usageAvailable?: boolean;
  };
};

export type ComposerProfileModelOption = {
  displayName?: string;
  effort?: string;
  efforts?: string[];
  label: string;
  value: string;
};

export type ComposerModelOption = ComposerProfileModelOption;

export type ComposerModelProviderOption = {
  label: string;
  models: ComposerModelOption[];
  value: string;
};

export type ComposerProfileOption = {
  label: string;
  models?: ComposerProfileModelOption[];
  value: string;
};

export type UnifiedComposerControls = {
  access?: ReactNode;
  attach?: ReactNode;
  context?: ReactNode;
  left?: ReactNode;
  model?: ReactNode;
  right?: ReactNode;
  submit?: ReactNode;
  voice?: ReactNode;
};

export type UnifiedComposerProps = Omit<
  ComposerSurfaceProps,
  'accessoryLeftTools' | 'accessoryRightTools' | 'children' | 'leftTools' | 'rightTools'
> & {
  accessoryControls?: ComposerAccessoryControls;
  ariaLabel?: string;
  controls?: UnifiedComposerControls;
  editor: ReactNode;
  voiceDebug?: ReactNode;
};

type ComposerLiquidGlassState = {
  filterId: string;
  height: number;
  mapUrl: string;
  scale: number;
  width: number;
};

type ComposerToolSlot = {
  key: string;
  node: ReactNode;
};

const LIQUID_GLASS_MAX_AREA = 130_000;
const LIQUID_GLASS_MAX_WIDTH = 900;
const LIQUID_GLASS_MAX_HEIGHT = 180;
const COMPOSER_LIQUID_GLASS_DEFAULT_ENABLED = true;
const liquidGlassMapCache = new Map<string, string>();

function composeComposerTools(slots: ComposerToolSlot[]): ReactNode {
  const visible = slots.filter((slot) => slot.node !== null && slot.node !== undefined && slot.node !== false);
  return visible.length ? visible.map((slot) => <Fragment key={slot.key}>{slot.node}</Fragment>) : null;
}

function composeComposerAccessoryTools(controls?: ComposerAccessoryControls): {
  left: ReactNode;
  right: ReactNode;
} {
  if (!controls) return { left: null, right: null };
  const enabled = new Set<ComposerAccessoryItem>(controls.items ?? ['access', 'usage', 'model', 'effort']);
  const left = composeComposerTools([
    {
      key: 'access',
      node:
        enabled.has('access') && controls.access ? (
          <ComposerAccessSelect
            ariaLabel={controls.access.ariaLabel ?? 'Approval strength'}
            askLabel={controls.access.askLabel}
            autoLabel={controls.access.autoLabel}
            mode={controls.access.mode}
            onChange={controls.access.onChange}
          />
        ) : null
    }
  ]);
  const right = composeComposerTools([
    {
      key: 'usage',
      node: enabled.has('usage') && controls.usage ? <ComposerUsageControl usage={controls.usage} /> : null
    },
    {
      key: 'model',
      node: enabled.has('model') ? (
        <ComposerModelAccessory model={controls.model ?? legacyProfileModel(controls.profile)} />
      ) : null
    },
    {
      key: 'effort',
      node: enabled.has('effort') && controls.effort ? <ComposerEffortAccessory effort={controls.effort} /> : null
    }
  ]);
  return { left, right };
}

function ComposerModelAccessory({
  model
}: {
  model?: NonNullable<ComposerAccessoryControls['model']>;
}): ReactElement | null {
  return model ? <ComposerModelPicker model={model} /> : null;
}

function ComposerEffortAccessory({
  effort
}: {
  effort: NonNullable<ComposerAccessoryControls['effort']>;
}): ReactElement {
  return (
    <Popover onOpenChange={effort.onOpenChange}>
      <PopoverTrigger asChild>
        <button
          aria-label={effort.ariaLabel ?? 'Effort'}
          className="workplace-action shared-composer-pill"
          style={{
            alignItems: 'center',
            background: 'var(--shared-composer-control-bg, transparent)',
            border: 'none',
            borderRadius: 999,
            color: 'var(--shared-composer-control-fg, var(--muted-foreground))',
            cursor: 'pointer',
            display: 'inline-flex',
            flex: 'none',
            fontFamily: 'var(--font-sans), ui-sans-serif, system-ui, sans-serif',
            fontSize: 'var(--shared-composer-font-size, 13px)',
            fontWeight: 'var(--shared-composer-font-weight, 500)',
            gap: 4,
            minHeight: 32,
            padding: '0 var(--shared-composer-pill-x, 7px)',
            whiteSpace: 'nowrap'
          }}
          type="button"
        >
          {effortLabel(effort.current) || effort.ariaLabel || 'Effort'}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 p-2.5"
        collisionPadding={12}
        side="top"
        sticky="partial"
      >
        {effort.control}
      </PopoverContent>
    </Popover>
  );
}

function legacyProfileModel(
  profile: ComposerAccessoryControls['profile']
): NonNullable<ComposerAccessoryControls['model']> | undefined {
  if (!profile) return undefined;
  const profiles: ComposerProfileOption[] =
    profile.profiles ?? profile.options.map((option) => ({ label: option.label, value: option.value }));
  return {
    ariaLabel: profile.ariaLabel,
    currentModel: profile.currentModel,
    currentProvider: profile.current,
    onModelChange: profile.onModelChange,
    onProviderChange: profile.onChange,
    placeholder: profile.placeholder,
    providers: profiles.map((item) => ({
      label: item.label,
      models: item.models ?? [],
      value: item.value
    }))
  };
}

function effortLabel(effort: string | undefined): string {
  if (!effort) return '';
  return effort
    .split(/([-_])/)
    .map((part) => (part === '-' || part === '_' ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

export function composerModelMenuLayout() {
  return {
    align: 'start' as const,
    collisionPadding: 12,
    itemClassName: 'cursor-pointer',
    modelListClassName: 'h-72 overflow-y-auto',
    modelNameClassName: 'max-w-72 truncate pl-3',
    rootContentClassName: 'w-max min-w-[180px] max-w-[var(--radix-dropdown-menu-content-available-width)]',
    searchContainerClassName: 'w-full pb-2',
    searchInputClassName: 'h-8 w-full rounded-sm border bg-background px-2 text-sm outline-none',
    side: 'top' as const,
    subContentClassName:
      'w-max min-w-[160px] max-w-[var(--radix-dropdown-menu-content-available-width)] overflow-hidden',
    sticky: 'partial' as const,
    valueClassName: 'ml-auto max-w-56 truncate text-right text-muted-foreground'
  };
}

export function composerModelMenuPanelWidth(provider: ComposerModelProviderOption): number {
  const longestLabel = provider.models.reduce((longest, item) => {
    const label = item.displayName ?? item.label;
    return Math.max(longest, Array.from(label).length);
  }, Array.from(provider.label).length);
  return Math.min(352, Math.max(256, 72 + longestLabel * 7));
}

export function buildComposerModelMenuSections(
  model: Pick<NonNullable<ComposerAccessoryControls['model']>, 'currentModel' | 'currentProvider' | 'providers'>
) {
  return model.providers.map((provider) => ({
    label: provider.label,
    models: provider.models.map((item) => ({
      label: item.displayName ?? item.label,
      selected: provider.value === model.currentProvider && item.value === model.currentModel,
      value: item.value
    })),
    selected: provider.value === model.currentProvider,
    value: provider.value
  }));
}

type ComposerModelMenuHoverTarget = { kind: 'profile' } | { kind: 'provider'; provider: string };

export function composerModelMenuHoverState(target: ComposerModelMenuHoverTarget): { openProvider?: string } {
  return { openProvider: target.kind === 'provider' ? target.provider : undefined };
}

function ComposerModelPicker({ model }: { model: NonNullable<ComposerAccessoryControls['model']> }): ReactElement {
  const menuLayout = composerModelMenuLayout();
  const [hoverState, setHoverState] = useState(() => composerModelMenuHoverState({ kind: 'profile' }));
  const [query, setQuery] = useState('');
  const currentProvider = model.providers.find((item) => item.value === model.currentProvider) ?? model.providers[0];
  const currentModels = currentProvider?.models ?? [];
  const selectedModel =
    currentModels.find((item) => item.value === model.currentModel) ??
    currentModels[0] ??
    (model.currentModel ? { label: model.currentModel, value: model.currentModel } : undefined);
  const displayName =
    selectedModel?.displayName ??
    selectedModel?.label ??
    model.profileDefault?.modelLabel ??
    model.placeholder ??
    'Model';
  const filteredModels = (provider: ComposerModelProviderOption) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return provider.models;
    return provider.models.filter((item) =>
      `${item.displayName ?? ''} ${item.label} ${item.value}`.toLowerCase().includes(needle)
    );
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) return;
        setHoverState(composerModelMenuHoverState({ kind: 'profile' }));
        setQuery('');
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          aria-label={model.ariaLabel ?? 'Model'}
          className="workplace-action shared-composer-pill"
          style={{
            alignItems: 'center',
            background: 'var(--shared-composer-control-bg, transparent)',
            border: 'none',
            borderRadius: 999,
            color: 'var(--shared-composer-control-fg, var(--muted-foreground))',
            cursor: 'pointer',
            display: 'inline-flex',
            flex: 'none',
            fontFamily: 'var(--font-sans), ui-sans-serif, system-ui, sans-serif',
            fontSize: 'var(--shared-composer-font-size, 13px)',
            fontWeight: 'var(--shared-composer-font-weight, 500)',
            gap: 4,
            minHeight: 32,
            padding: '0 var(--shared-composer-pill-x, 7px)',
            whiteSpace: 'nowrap'
          }}
          type="button"
        >
          <span>{displayName}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={menuLayout.align}
        className={menuLayout.rootContentClassName}
        collisionPadding={menuLayout.collisionPadding}
        side={menuLayout.side}
        sticky={menuLayout.sticky}
      >
        <DropdownMenuLabel className="text-muted-foreground text-xs">
          {model.providersLabel ?? 'Providers'}
        </DropdownMenuLabel>
        {model.providers.map((provider) => {
          const providerModels = filteredModels(provider);
          const selected = provider.value === model.currentProvider;
          return (
            <DropdownMenuSub
              key={provider.value}
              onOpenChange={(open) =>
                setHoverState((current) =>
                  open
                    ? composerModelMenuHoverState({ kind: 'provider', provider: provider.value })
                    : current.openProvider === provider.value
                      ? composerModelMenuHoverState({ kind: 'profile' })
                      : current
                )
              }
              open={hoverState.openProvider === provider.value}
            >
              <DropdownMenuSubTrigger
                className={cn(menuLayout.itemClassName, 'justify-between gap-4')}
                onPointerEnter={() => {
                  if (hoverState.openProvider !== provider.value) setQuery('');
                  setHoverState(composerModelMenuHoverState({ kind: 'provider', provider: provider.value }));
                }}
              >
                <span>{provider.label}</span>
                {selected ? (
                  <HugeiconsIcon
                    className="text-muted-foreground"
                    icon={CheckIcon}
                    size={15}
                  />
                ) : null}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                className={menuLayout.subContentClassName}
                collisionPadding={menuLayout.collisionPadding}
                sideOffset={4}
                style={{ width: composerModelMenuPanelWidth(provider) }}
              >
                <div className={menuLayout.searchContainerClassName}>
                  <input
                    aria-label={model.searchModelsLabel ?? 'Search models'}
                    className={menuLayout.searchInputClassName}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                    placeholder={model.searchModelsLabel ?? 'Search models'}
                    value={query}
                  />
                </div>
                <div className={menuLayout.modelListClassName}>
                  {providerModels.length ? (
                    providerModels.map((item) => {
                      const active = selected && item.value === model.currentModel;
                      return (
                        <DropdownMenuItem
                          className={cn(menuLayout.itemClassName, 'justify-between gap-4')}
                          key={item.value}
                          onSelect={() => model.onModelChange?.(provider.value, item.value)}
                        >
                          <span className={menuLayout.modelNameClassName}>{item.displayName ?? item.label}</span>
                          {active ? (
                            <HugeiconsIcon
                              className="text-muted-foreground"
                              icon={CheckIcon}
                              size={15}
                            />
                          ) : null}
                        </DropdownMenuItem>
                      );
                    })
                  ) : (
                    <div className="px-2 py-6 text-center text-muted-foreground text-sm">
                      {model.noModelsLabel ?? 'No models'}
                    </div>
                  )}
                </div>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className={cn(menuLayout.itemClassName, 'justify-between gap-4')}
          onPointerEnter={() => setHoverState(composerModelMenuHoverState({ kind: 'profile' }))}
          onSelect={model.onUseProfile}
        >
          <span>{model.useProfileLabel ?? 'Use agent profile'}</span>
          <span className={menuLayout.valueClassName}>
            {model.profileDefault?.label ?? model.profileDefault?.modelLabel ?? 'Default'}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ComposerUsageControl({ usage }: { usage: NonNullable<ComposerAccessoryControls['usage']> }): ReactElement {
  const presentation = resolveComposerUsagePresentation(usage);
  const button = (
    <ComposerContextUsageButton
      ariaLabel={usage.ariaLabel ?? 'Context usage'}
      percent={usage.percent}
      title={presentation.tooltipLabel}
      usageAvailable
    />
  );
  return (
    <Popover>
      <Tooltip>
        <PopoverTrigger asChild>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
        </PopoverTrigger>
        <TooltipContent side="top">{presentation.tooltipLabel}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        className="w-72 p-0"
        collisionPadding={12}
        side="top"
        sticky="partial"
      >
        {usage.panel ? (
          <ComposerContextUsagePanel
            {...usage.panel}
            percent={usage.percent}
          />
        ) : (
          <div className="p-3 text-muted-foreground text-sm">{presentation.panelLabel}</div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function resolveComposerUsagePresentation(usage: NonNullable<ComposerAccessoryControls['usage']>): {
  panelLabel: string;
  tooltipLabel: string;
} {
  if (!usage.panel) {
    const unavailableLabel = usage.unavailableLabel ?? usage.title ?? usage.ariaLabel ?? 'Context usage';
    return { panelLabel: unavailableLabel, tooltipLabel: unavailableLabel };
  }
  const tooltipLabel = `${usage.percent}% ${usage.panel.contextUsedLabel}`;
  return { panelLabel: tooltipLabel, tooltipLabel };
}

export function UnifiedComposer({
  accessoryControls,
  ariaLabel = 'Message composer',
  controls,
  editor,
  voiceDebug,
  ...surfaceProps
}: UnifiedComposerProps): ReactElement {
  const leftTools =
    controls?.left ??
    composeComposerTools([
      { key: 'attach', node: controls?.attach },
      { key: 'access', node: controls?.access }
    ]);
  const rightTools =
    controls?.right ??
    composeComposerTools([
      { key: 'context', node: controls?.context },
      { key: 'model', node: controls?.model },
      { key: 'voice', node: controls?.voice },
      { key: 'submit', node: controls?.submit }
    ]);
  const accessoryTools = composeComposerAccessoryTools(accessoryControls);

  return (
    <fieldset
      aria-label={ariaLabel}
      style={{
        border: 0,
        margin: 0,
        minInlineSize: 0,
        padding: 0
      }}
    >
      <ComposerSurface
        {...surfaceProps}
        accessoryLeftTools={accessoryTools.left}
        accessoryRightTools={accessoryTools.right}
        leftTools={leftTools}
        rightTools={rightTools}
      >
        {editor}
        {voiceDebug}
      </ComposerSurface>
    </fieldset>
  );
}

export function ComposerSurface({
  accessoryLeftTools,
  accessoryRightTools,
  ariaBusy,
  children,
  className,
  leftTools,
  liquidGlass = COMPOSER_LIQUID_GLASS_DEFAULT_ENABLED,
  mentionMenu,
  mentionPreview,
  rightTools,
  voiceLevel = 0,
  voiceSpectrum,
  voiceState = 'idle'
}: ComposerSurfaceProps): ReactElement {
  const voiceActive = voiceState !== 'idle';
  const frameRef = useRef<HTMLDivElement | null>(null);
  const liquidGlassState = useComposerLiquidGlass(frameRef, liquidGlass);
  const hasPrimaryToolbar = leftTools || rightTools;
  const hasAccessoryRail = accessoryLeftTools || accessoryRightTools;
  return (
    <ChatInputChrome
      className={cn(
        'shared-composer-panel',
        liquidGlassState && 'chat-input-chrome--liquid-glass',
        voiceActive && 'chat-input-chrome--voice-active',
        className
      )}
      style={
        liquidGlassState
          ? ({
              '--composer-liquid-glass-filter': `url(#${liquidGlassState.filterId})`
            } as CSSProperties)
          : undefined
      }
    >
      {liquidGlassState ? <ComposerLiquidGlassFilter state={liquidGlassState} /> : null}
      <div
        className="chat-input-frame"
        ref={frameRef}
      >
        <div className="chat-input-surface-frame">
          <div
            aria-hidden="true"
            className="chat-input-aurora"
          >
            <div className="chat-input-aurora-root">
              <div className="chat-input-aurora-inner-glow">
                <div className="chat-input-aurora-glow-pulse">
                  <div className="chat-input-aurora-edge-mask">
                    <div className="chat-input-aurora-blur-field">
                      <div className="chat-input-aurora-gradient" />
                    </div>
                  </div>
                </div>
              </div>
              <div className="chat-input-aurora-border-pulse">
                <div className="chat-input-aurora-border-mask">
                  <div className="chat-input-aurora-gradient" />
                </div>
              </div>
            </div>
          </div>
          <div
            className="chat-input-surface composer-live-dense"
            role="presentation"
          >
            <div
              aria-busy={ariaBusy || undefined}
              className="chat-input-content"
              onBeforeInputCapture={(event) => {
                if (ariaBusy) event.preventDefault();
              }}
              onDropCapture={(event) => {
                if (ariaBusy) event.preventDefault();
              }}
              onKeyDownCapture={(event) => {
                if (ariaBusy) event.preventDefault();
              }}
              onPasteCapture={(event) => {
                if (ariaBusy) event.preventDefault();
              }}
              style={{
                opacity: ariaBusy ? 0.72 : 1,
                pointerEvents: ariaBusy ? 'none' : undefined
              }}
            >
              {children}
              {mentionPreview ? (
                <div
                  className="flex flex-wrap items-center gap-1.5 text-[13px]"
                  style={{ color: 'var(--muted-foreground)' }}
                >
                  {mentionPreview}
                </div>
              ) : null}
            </div>

            <ComposerVoiceSpectrum
              level={voiceLevel}
              spectrum={voiceSpectrum}
              state={voiceState}
            />

            {hasPrimaryToolbar ? (
              <div
                className="shared-composer-toolbar"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 5,
                  padding: 0
                }}
              >
                <div
                  className="shared-composer-tools"
                  style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}
                >
                  {leftTools}
                </div>
                <div
                  className="shared-composer-tools shared-composer-tools-right"
                  style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto', minWidth: 0 }}
                >
                  {rightTools}
                </div>
              </div>
            ) : null}
          </div>
        </div>
        {hasAccessoryRail ? (
          <div
            className="shared-composer-accessory-rail"
            style={{
              alignItems: 'center',
              display: 'flex',
              gap: 8,
              justifyContent: 'space-between',
              minWidth: 0
            }}
          >
            <div
              className="shared-composer-accessory shared-composer-accessory-left"
              style={{ alignItems: 'center', display: 'inline-flex', gap: 4, minWidth: 0 }}
            >
              {accessoryLeftTools}
            </div>
            <div
              className="shared-composer-accessory shared-composer-accessory-right"
              style={{ alignItems: 'center', display: 'inline-flex', gap: 4, marginLeft: 'auto', minWidth: 0 }}
            >
              {accessoryRightTools}
            </div>
          </div>
        ) : null}
        {mentionMenu}
      </div>
    </ChatInputChrome>
  );
}

function ComposerLiquidGlassFilter({ state }: { state: ComposerLiquidGlassState }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="composer-liquid-glass-filter"
      focusable="false"
    >
      <filter
        colorInterpolationFilters="sRGB"
        id={state.filterId}
      >
        <feImage
          height="100%"
          href={state.mapUrl}
          preserveAspectRatio="none"
          result="composer-liquid-glass-map"
          width="100%"
          x="0"
          y="0"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="composer-liquid-glass-map"
          scale={state.scale}
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  );
}

function useComposerLiquidGlass(
  ref: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  refraction = 0.7
): ComposerLiquidGlassState | null {
  const reactId = useId();
  const filterId = useMemo(() => `composer-liquid-glass-${reactId.replaceAll(/[^a-zA-Z0-9_-]/g, '')}`, [reactId]);
  const [size, setSize] = useState<{ height: number; width: number } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined') return;
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const update = (): void => {
      const rect = node.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setSize((current) => (current?.width === width && current.height === height ? current : { width, height }));
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    });
    observer.observe(node);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [enabled, ref]);

  return useMemo(() => {
    if (!enabled) return null;
    if (!size) return null;
    if (size.width <= 0 || size.height <= 0) return null;
    if (size.width > LIQUID_GLASS_MAX_WIDTH || size.height > LIQUID_GLASS_MAX_HEIGHT) return null;
    if (size.width * size.height > LIQUID_GLASS_MAX_AREA) return null;
    const mapUrl = composerLiquidGlassMap(size.width, size.height);
    if (!mapUrl) return null;
    const baseScale = Math.max(10, Math.min(24, Math.round(size.height * 0.18)));
    const normalizedRefraction = Number.isFinite(refraction) ? Math.max(0, Math.min(1.5, refraction)) : 1;
    return {
      filterId,
      height: size.height,
      mapUrl,
      scale: Math.max(0, Math.min(36, Math.round(baseScale * normalizedRefraction))),
      width: size.width
    };
  }, [enabled, filterId, refraction, size]);
}

function composerLiquidGlassMap(width: number, height: number): string | null {
  if (typeof document === 'undefined') return null;
  const key = `${width}x${height}`;
  const cached = liquidGlassMapCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: false });
  if (!context) return null;

  const image = context.createImageData(width, height);
  const data = image.data;
  const radius = Math.min(18, Math.floor(Math.min(width, height) * 0.22));
  const bezel = Math.max(12, Math.min(28, Math.round(Math.min(width, height) * 0.24)));
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const innerWidth = Math.max(1, halfWidth - radius);
  const innerHeight = Math.max(1, halfHeight - radius);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offsetX = Math.abs(x - halfWidth) - innerWidth;
      const offsetY = Math.abs(y - halfHeight) - innerHeight;
      const outsideX = Math.max(offsetX, 0);
      const outsideY = Math.max(offsetY, 0);
      const signedDistance = Math.hypot(outsideX, outsideY) + Math.min(Math.max(offsetX, offsetY), 0) - radius;
      const edge = Math.max(0, 1 - Math.abs(signedDistance) / bezel);
      const eased = edge * edge * (3 - 2 * edge);
      const cornerPull = Math.max(0, Math.min(1, (Math.abs(offsetX) + Math.abs(offsetY)) / (bezel * 2)));
      const strength = eased * (0.64 + cornerPull * 0.36);
      const index = (y * width + x) * 4;
      data[index] = 128 + (x < halfWidth ? -1 : 1) * strength * 92;
      data[index + 1] = 128 + (y < halfHeight ? -1 : 1) * strength * 92;
      data[index + 2] = 128;
      data[index + 3] = 255;
    }
  }

  context.putImageData(image, 0, 0);
  const mapUrl = canvas.toDataURL('image/png');
  liquidGlassMapCache.set(key, mapUrl);
  const oldestKey = liquidGlassMapCache.keys().next().value;
  if (liquidGlassMapCache.size > 24 && oldestKey) liquidGlassMapCache.delete(oldestKey);
  return mapUrl;
}

function ComposerVoiceSpectrum({
  level,
  spectrum,
  state
}: {
  level: number;
  spectrum?: number[];
  state: 'idle' | 'listening' | 'busy';
}): ReactElement | null {
  if (state === 'idle') return null;
  const normalized = state === 'busy' ? 0.18 : Math.max(0.08, Math.min(1, level));
  const rays = [
    { id: 'a', weight: 0.46 },
    { id: 'b', weight: 0.68 },
    { id: 'c', weight: 0.52 },
    { id: 'd', weight: 0.86 },
    { id: 'e', weight: 0.58 },
    { id: 'f', weight: 1 },
    { id: 'g', weight: 0.64 },
    { id: 'h', weight: 0.92 },
    { id: 'i', weight: 0.5 },
    { id: 'j', weight: 0.76 },
    { id: 'k', weight: 0.56 },
    { id: 'l', weight: 0.82 },
    { id: 'm', weight: 0.44 },
    { id: 'n', weight: 0.72 },
    { id: 'o', weight: 0.54 },
    { id: 'p', weight: 0.88 },
    { id: 'q', weight: 0.62 },
    { id: 'r', weight: 0.96 },
    { id: 's', weight: 0.48 },
    { id: 't', weight: 0.78 }
  ];

  return (
    <div
      aria-hidden="true"
      className={cn('composer-voice-spectrum', state === 'busy' && 'composer-voice-spectrum--busy')}
    >
      <span className="composer-voice-spectrum__core">
        {state === 'busy' ? (
          <svg
            aria-hidden="true"
            className="composer-voice-spectrum__scribe"
            viewBox="0 0 32 32"
          >
            <path
              className="composer-voice-spectrum__scribe-line"
              d="M7 23H19"
            />
            <path
              className="composer-voice-spectrum__scribe-line composer-voice-spectrum__scribe-line--late"
              d="M7 27H24"
            />
            <g className="composer-voice-spectrum__scribe-pen">
              <path d="M12 20L22 10L26 14L16 24L11 25L12 20Z" />
              <path d="M21 11L25 15" />
            </g>
          </svg>
        ) : null}
      </span>
      {rays.map((ray, index) => {
        const angle = (360 / rays.length) * index;
        const band = spectrum && spectrum.length > 0 ? spectrum[index % spectrum.length] : undefined;
        const energy = band == null ? normalized * ray.weight : Math.max(0.04, Math.min(1, band));
        const length = state === 'busy' ? 7 + ((index + 1) % 4) * 2 : 5 + Math.round(energy * 15);
        const opacity = state === 'busy' ? 0.16 : 0.52 + energy * 0.42;
        return (
          <span
            className="composer-voice-spectrum__ray"
            key={ray.id}
            style={{
              animationDelay: `${index * 24}ms`,
              transform: `rotate(${angle}deg)`
            }}
          >
            <span
              className="composer-voice-spectrum__ray-core"
              style={
                {
                  '--composer-voice-ray-length': `${length}px`,
                  opacity
                } as CSSProperties
              }
            />
          </span>
        );
      })}
    </div>
  );
}

export function ComposerSwap({
  ask,
  asking,
  composer
}: {
  ask?: ReactNode;
  asking: boolean;
  composer: ReactNode;
}): ReactElement {
  return (
    <div style={{ padding: '14px 16px 18px', position: 'relative' }}>
      <style>{`
        .monad-ui-composer-host {
          transition:
            opacity 220ms ease,
            transform 260ms cubic-bezier(.2,.9,.24,1);
          transform-origin: bottom center;
        }
        .monad-ui-composer-host.is-asking {
          opacity: 0;
          pointer-events: none;
          transform: translateY(34px) scale(.985);
        }
        .monad-ui-question-slot {
          animation: monadUiQuestionSlotIn 280ms cubic-bezier(.16,1.1,.3,1) both;
          transform-origin: bottom center;
        }
        @keyframes monadUiQuestionSlotIn {
          0% { opacity: 0; transform: translateY(42px) scale(.965); }
          62% { opacity: 1; transform: translateY(-6px) scale(1.006); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
      {ask ? (
        <div
          className="monad-ui-question-slot"
          style={{
            bottom: 18,
            left: 16,
            position: 'absolute',
            right: 16,
            zIndex: 30
          }}
        >
          {ask}
        </div>
      ) : null}
      <div
        aria-hidden={asking}
        className={asking ? 'monad-ui-composer-host is-asking' : 'monad-ui-composer-host'}
      >
        {composer}
      </div>
    </div>
  );
}

export function ComposerSelect({
  ariaLabel,
  children,
  disabled = false,
  icon,
  onChange,
  showChevron = true,
  tone = 'accent',
  value
}: {
  ariaLabel: string;
  children: ReactNode;
  disabled?: boolean;
  icon?: ReactNode;
  onChange?: (value: string) => void;
  showChevron?: boolean;
  tone?: 'accent' | 'ink';
  value: string;
}): ReactElement {
  return (
    <label
      className="workplace-action shared-composer-pill"
      style={{
        flex: 'none',
        minHeight: 32,
        border: 'none',
        borderRadius: 999,
        background: 'var(--shared-composer-control-bg, transparent)',
        color: disabled
          ? 'var(--muted-foreground)'
          : `var(--shared-composer-control-fg, ${tone === 'ink' ? 'var(--foreground)' : 'var(--muted-foreground)'})`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '0 var(--shared-composer-pill-x, 7px)',
        fontFamily: 'var(--font-sans), ui-sans-serif, system-ui, sans-serif',
        fontSize: 'var(--shared-composer-font-size, 14px)',
        fontWeight: 'var(--shared-composer-font-weight, 600)',
        whiteSpace: 'nowrap',
        opacity: disabled ? 0.62 : 1
      }}
    >
      {icon}
      <select
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={(event) => onChange?.(event.currentTarget.value)}
        style={{
          appearance: 'none',
          border: 'none',
          background: 'var(--shared-composer-control-bg, transparent)',
          color: 'inherit',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fieldSizing: 'content',
          font: 'inherit',
          outline: 'none'
        }}
        value={value}
      >
        {children}
      </select>
      {showChevron ? (
        <HugeiconsIcon
          aria-hidden
          icon={ChevronDownIcon}
          size={14}
        />
      ) : null}
    </label>
  );
}

export type ComposerAccessMode = 'auto' | 'ask';

export function ComposerAccessSelect({
  ariaLabel,
  askLabel,
  autoLabel,
  mode,
  onChange
}: {
  ariaLabel: string;
  askLabel: string;
  autoLabel: string;
  mode: ComposerAccessMode;
  onChange?: (mode: ComposerAccessMode) => void;
}): ReactElement {
  return (
    <ComposerSelect
      ariaLabel={ariaLabel}
      icon={
        <HugeiconsIcon
          icon={ShieldQuestionMarkIcon}
          size={15}
        />
      }
      onChange={(nextValue) => onChange?.(nextValue as ComposerAccessMode)}
      showChevron={false}
      tone="ink"
      value={mode}
    >
      <option value="auto">{autoLabel}</option>
      <option value="ask">{askLabel}</option>
    </ComposerSelect>
  );
}

export function ComposerModelSelect({
  ariaLabel,
  current,
  onChange,
  options,
  placeholder = 'Model'
}: {
  ariaLabel: string;
  current?: string;
  onChange?: (model: string) => void;
  options: { label: string; value: string }[];
  placeholder?: string;
}): ReactElement {
  const effectiveOptions = options.length ? options : [{ label: placeholder, value: '' }];
  return (
    <ComposerSelect
      ariaLabel={ariaLabel}
      disabled={options.length === 0}
      onChange={onChange}
      tone="ink"
      value={current ?? effectiveOptions[0]?.value ?? ''}
    >
      {effectiveOptions.map((option) => (
        <option
          key={option.value}
          value={option.value}
        >
          {option.label}
        </option>
      ))}
    </ComposerSelect>
  );
}

export type ComposerIconButtonProps = Omit<ComponentPropsWithoutRef<'button'>, 'aria-label'> & {
  active?: boolean;
  ariaDisabled?: boolean;
  ariaLabel: string;
  children: ReactNode;
};

export const ComposerIconButton = forwardRef<HTMLButtonElement, ComposerIconButtonProps>(function ComposerIconButton(
  { active = false, ariaDisabled = false, ariaLabel, children, disabled = false, style, ...props },
  ref
): ReactElement {
  return (
    <button
      {...props}
      aria-disabled={ariaDisabled || disabled}
      aria-label={ariaLabel}
      className="workplace-action"
      disabled={disabled}
      ref={ref}
      style={{
        flex: 'none',
        width: 34,
        height: 34,
        border: 'none',
        borderRadius: '50%',
        background: active ? 'var(--accent-blue-soft)' : 'var(--shared-composer-control-bg, transparent)',
        color: active ? 'var(--accent-blue)' : 'var(--shared-composer-control-fg, var(--muted-foreground))',
        cursor: disabled || ariaDisabled ? 'not-allowed' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled || ariaDisabled ? 0.48 : 1,
        ...style
      }}
      type="button"
    >
      {children}
    </button>
  );
});

export type ComposerVoiceButtonProps = Omit<ComposerIconButtonProps, 'active' | 'children'> & {
  state?: 'idle' | 'listening' | 'busy';
};

export const ComposerVoiceButton = forwardRef<HTMLButtonElement, ComposerVoiceButtonProps>(function ComposerVoiceButton(
  { state = 'idle', ...props },
  ref
): ReactElement {
  const active = state === 'listening' || state === 'busy';
  return (
    <ComposerIconButton
      {...props}
      active={active}
      ref={ref}
    >
      {state === 'busy' ? (
        <HugeiconsIcon
          className="animate-spin"
          icon={MagicWand02Icon}
          size={17}
        />
      ) : (
        <span className="relative inline-flex items-center justify-center">
          <HugeiconsIcon
            className={state === 'listening' ? 'text-destructive' : undefined}
            icon={Mic01Icon}
            size={17}
          />
          {state === 'listening' ? (
            <span className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-destructive" />
          ) : null}
        </span>
      )}
    </ComposerIconButton>
  );
});

export type ComposerContextUsageButtonProps = Omit<ComponentPropsWithoutRef<'button'>, 'aria-label'> & {
  ariaLabel: string;
  percent: number;
  title?: string;
  usageAvailable?: boolean;
};

export const ComposerContextUsageButton = forwardRef<HTMLButtonElement, ComposerContextUsageButtonProps>(
  function ComposerContextUsageButton(
    { ariaLabel, percent, style, title, usageAvailable = false, ...props },
    ref
  ): ReactElement {
    const circumference = 2 * Math.PI * 10;
    const clampedPercent = Math.max(0, Math.min(100, Math.round(percent)));
    const dashOffset = circumference * (1 - clampedPercent / 100);

    return (
      <button
        {...props}
        aria-label={ariaLabel}
        className="workplace-action"
        ref={ref}
        style={{
          flex: 'none',
          width: 32,
          height: 32,
          border: 'none',
          borderRadius: '50%',
          background: 'transparent',
          color: 'var(--shared-composer-control-fg, var(--muted-foreground))',
          cursor: usageAvailable ? 'pointer' : 'default',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          ...style
        }}
        title={title}
        type="button"
      >
        <svg
          aria-hidden="true"
          height="18"
          viewBox="0 0 24 24"
          width="18"
        >
          <circle
            cx="12"
            cy="12"
            fill="none"
            opacity="0.25"
            r="10"
            stroke="currentColor"
            strokeWidth="2"
          />
          <circle
            cx="12"
            cy="12"
            fill="none"
            opacity="0.78"
            r="10"
            stroke="currentColor"
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            strokeWidth="2"
            style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
          />
        </svg>
      </button>
    );
  }
);

export function ComposerVoiceUnavailableContent({
  onSettingsClick,
  reason,
  requiresModelSettings,
  settingsLabel,
  setupPrefix,
  setupSuffix
}: {
  onSettingsClick?: () => void;
  reason: string;
  requiresModelSettings?: boolean;
  settingsLabel: string;
  setupPrefix: string;
  setupSuffix: string;
}): ReactElement {
  if (!requiresModelSettings) return <>{reason}</>;
  return (
    <span>
      {setupPrefix}{' '}
      <button
        className="font-medium text-accent-blue underline underline-offset-2"
        onClick={() => onSettingsClick?.()}
        type="button"
      >
        {settingsLabel}
      </button>{' '}
      {setupSuffix}
    </span>
  );
}

export type ComposerSubmitButtonProps = Omit<ComponentPropsWithoutRef<'button'>, 'aria-label'> & {
  ariaLabel: string;
  canSend?: boolean;
  canStop?: boolean;
};

export const ComposerSubmitButton = forwardRef<HTMLButtonElement, ComposerSubmitButtonProps>(
  function ComposerSubmitButton(
    { ariaLabel, canSend = false, canStop = false, disabled = false, onClick, style, ...props },
    ref
  ): ReactElement {
    const enabled = canSend || canStop;
    const interactive = enabled && !disabled;
    return (
      <button
        {...props}
        aria-label={ariaLabel}
        className="workplace-action shared-composer-submit"
        disabled={disabled}
        onClick={onClick}
        ref={ref}
        style={{
          flex: 'none',
          width: 36,
          height: 36,
          border: 'none',
          borderRadius: '50%',
          background: interactive ? 'var(--primary)' : 'rgb(var(--backgroundColor-state-enabled) / 0.48)',
          color: interactive ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
          cursor: interactive ? 'pointer' : 'not-allowed',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          ...style
        }}
        type="button"
      >
        {canStop ? (
          <HugeiconsIcon
            fill="currentColor"
            icon={SquareIcon}
            size={16}
          />
        ) : (
          <HugeiconsIcon
            icon={CornerDownLeftIcon}
            size={17}
          />
        )}
      </button>
    );
  }
);
