import type { CSSProperties, ReactElement } from 'react';

import { PackageIcon, TerminalIcon } from '@hugeicons/core-free-icons';
import { mergeAttributes } from '@tiptap/core';

const HUGEICONS_SYMBOL_NAME_RE = /^[A-Z][A-Za-z0-9]*Icon$/;
const HTTP_ICON_RE = /^https?:\/\//i;
const COMPOSER_INLINE_CHIP_CLASS =
  'inline-flex items-baseline gap-[0.14em] align-baseline text-[0.92em] text-accent-blue leading-[inherit]';
const COMPOSER_INLINE_CHIP_ICON_CLASS =
  'inline-flex size-[0.94em] shrink-0 translate-y-[0.14em] items-center justify-center text-[0.94em] leading-none';
const MONAD_ICON_MASK_IMAGE = 'url("/monad-icon-vector-solid.svg")';

export type ComposerInlineChipKind = 'command' | 'mention' | 'skill';
export type ComposerInlineChipProps = {
  icon?: string;
  kind: ComposerInlineChipKind;
  label: string;
  onClick?: () => void;
  title?: string;
};

type ComposerDomChild = ComposerDomSpec | string;
type ComposerDomSpec = [string, Record<string, unknown>, ...ComposerDomChild[]];
type ComposerInlineChipIconSpec = ComposerDomSpec;
type ComposerInlineChipSpec = ['span', Record<string, unknown>, ComposerInlineChipIconSpec, string];

function escapedCssUrl(url: string): string {
  return url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function renderableIconText(icon: string | undefined): string | undefined {
  if (!icon) return undefined;
  const value = icon.trim();
  if (!value || HUGEICONS_SYMBOL_NAME_RE.test(value)) return undefined;
  return value;
}

function svgAttributeName(name: string): string {
  return name.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function hugeiconMaskImage(icon: unknown): string {
  const paths: string = Array.isArray(icon)
    ? icon
        .filter((item): item is [string, Record<string, unknown>] => Array.isArray(item) && typeof item[0] === 'string')
        .map(([tag, attributes]) => {
          const normalizedAttributes = Object.fromEntries(
            Object.entries(attributes ?? {})
              .filter(([name]) => name !== 'key')
              .map(([name, value]) => [svgAttributeName(name), value === 'currentColor' ? 'black' : value])
          );
          const serializedAttributes = Object.entries(normalizedAttributes)
            .map(([name, value]) => `${name}="${String(value).replace(/"/g, '&quot;')}"`)
            .join(' ');
          return `<${tag} ${serializedAttributes} />`;
        })
        .join('')
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">${paths}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function fallbackMaskImage(kind: ComposerInlineChipKind): string {
  if (kind === 'skill') return hugeiconMaskImage(PackageIcon);
  if (kind === 'command') return hugeiconMaskImage(TerminalIcon);
  return MONAD_ICON_MASK_IMAGE;
}

function maskStyleText(maskImage: string): string {
  return `mask-image: ${maskImage}; -webkit-mask-image: ${maskImage}; mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat; mask-position: center; -webkit-mask-position: center; mask-size: contain; -webkit-mask-size: contain;`;
}

function maskStyle(maskImage: string): CSSProperties {
  return {
    maskImage,
    maskPosition: 'center',
    maskRepeat: 'no-repeat',
    maskSize: 'contain',
    WebkitMaskImage: maskImage,
    WebkitMaskPosition: 'center',
    WebkitMaskRepeat: 'no-repeat',
    WebkitMaskSize: 'contain'
  };
}

function renderComposerInlineChipIcon(kind: ComposerInlineChipKind, icon?: string): ComposerInlineChipIconSpec {
  if (icon && HTTP_ICON_RE.test(icon)) {
    return [
      'span',
      {
        'aria-hidden': 'true',
        class: `${COMPOSER_INLINE_CHIP_ICON_CLASS} rounded bg-center bg-cover`,
        'data-composer-chip-icon': kind,
        style: `background-image: url("${escapedCssUrl(icon)}");`
      }
    ];
  }
  const iconText = renderableIconText(icon);
  if (iconText) {
    return [
      'span',
      {
        'aria-hidden': 'true',
        class: COMPOSER_INLINE_CHIP_ICON_CLASS,
        'data-composer-chip-icon': kind
      },
      iconText
    ];
  }
  return [
    'span',
    {
      'aria-hidden': 'true',
      class: `${COMPOSER_INLINE_CHIP_ICON_CLASS} bg-current`,
      'data-composer-chip-icon': kind,
      style: maskStyleText(fallbackMaskImage(kind))
    }
  ];
}

export function renderComposerInlineChip({
  attributes,
  icon,
  kind,
  label
}: Omit<ComposerInlineChipProps, 'onClick'> & {
  attributes?: Record<string, unknown>;
}): ComposerInlineChipSpec {
  return [
    'span',
    mergeAttributes(attributes ?? {}, {
      class: COMPOSER_INLINE_CHIP_CLASS,
      'data-composer-chip': kind
    }),
    renderComposerInlineChipIcon(kind, icon),
    label
  ];
}

export function ComposerInlineChip({ icon, kind, label, onClick, title }: ComposerInlineChipProps): ReactElement {
  const iconText = renderableIconText(icon);
  const iconNode =
    icon && HTTP_ICON_RE.test(icon) ? (
      <span
        aria-hidden="true"
        className={`${COMPOSER_INLINE_CHIP_ICON_CLASS} rounded bg-center bg-cover`}
        data-composer-chip-icon={kind}
        style={{ backgroundImage: `url("${escapedCssUrl(icon)}")` }}
      />
    ) : iconText ? (
      <span
        aria-hidden="true"
        className={COMPOSER_INLINE_CHIP_ICON_CLASS}
        data-composer-chip-icon={kind}
      >
        {iconText}
      </span>
    ) : (
      <span
        aria-hidden="true"
        className={`${COMPOSER_INLINE_CHIP_ICON_CLASS} bg-current`}
        data-composer-chip-icon={kind}
        style={maskStyle(fallbackMaskImage(kind))}
      />
    );
  const content = (
    <>
      {iconNode}
      {label}
    </>
  );

  return onClick ? (
    <button
      className={COMPOSER_INLINE_CHIP_CLASS}
      data-composer-chip={kind}
      onClick={onClick}
      title={title}
      type="button"
    >
      {content}
    </button>
  ) : (
    <span
      className={COMPOSER_INLINE_CHIP_CLASS}
      data-composer-chip={kind}
      title={title}
    >
      {content}
    </span>
  );
}
