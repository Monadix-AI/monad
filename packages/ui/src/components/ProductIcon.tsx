import type * as React from 'react';
import type { CSSProperties } from 'react';

import { useId } from 'react';

export type ProductIconId = 'codex' | 'claude-code' | 'gemini' | 'gemini-cli' | 'qwen';

export interface ProductIconColors {
  background?: string;
  foreground?: string;
  accent?: string;
  accent2?: string;
  accent3?: string;
  border?: string;
}

export interface ProductIconProps {
  // Open: product ids are extensible (a third-party agent-adapter atom can add one). Known ids keep
  // autocomplete; an unknown id renders the neutral default glyph + uses the id as its label.
  product: ProductIconId | (string & {});
  className?: string;
  size?: number | string;
  title?: string;
  colors?: ProductIconColors;
  lightColors?: ProductIconColors;
  darkColors?: ProductIconColors;
}

const PRODUCT_TITLES: Record<ProductIconId, string> = {
  codex: 'OpenAI Codex',
  'claude-code': 'Claude Code',
  gemini: 'Gemini CLI',
  'gemini-cli': 'Gemini CLI',
  qwen: 'Qwen Code'
};

const PRODUCT_IDS = new Set<ProductIconId>(['codex', 'claude-code', 'gemini', 'gemini-cli', 'qwen']);

function vars(colors?: ProductIconColors): CSSProperties {
  return {
    ...(colors?.background ? { '--product-icon-bg': colors.background } : {}),
    ...(colors?.foreground ? { '--product-icon-fg': colors.foreground } : {}),
    ...(colors?.accent ? { '--product-icon-accent': colors.accent } : {}),
    ...(colors?.accent2 ? { '--product-icon-accent-2': colors.accent2 } : {}),
    ...(colors?.accent3 ? { '--product-icon-accent-3': colors.accent3 } : {}),
    ...(colors?.border ? { '--product-icon-border': colors.border } : {})
  } as CSSProperties;
}

export function isProductIconId(value: string | undefined): value is ProductIconId {
  return PRODUCT_IDS.has(value as ProductIconId);
}

export function ProductIcon({
  product,
  className,
  size,
  title,
  colors,
  lightColors,
  darkColors
}: ProductIconProps): React.ReactElement {
  const gradientId = useId().replaceAll(':', '');
  const resolvedSize = size ?? (className ? undefined : '1em');
  const baseStyle = {
    display: 'inline-flex',
    flex: 'none',
    lineHeight: 1,
    verticalAlign: 'middle',
    ...(resolvedSize === undefined ? {} : { width: resolvedSize, height: resolvedSize })
  } as CSSProperties;
  const style = {
    ...baseStyle,
    ...vars(lightColors),
    ...vars(colors)
  } as CSSProperties;
  const darkStyle = {
    ...baseStyle,
    ...vars(darkColors),
    ...vars(colors)
  } as CSSProperties;
  const label = title ?? PRODUCT_TITLES[product as ProductIconId] ?? product;
  const renderIcon = (id: string) => (
    <ProductIconSvg
      gradientId={id}
      product={product}
      title={label}
    />
  );

  if (!darkColors) {
    return (
      <span
        aria-label={label}
        className={className}
        role="img"
        style={style}
      >
        {renderIcon(`product-icon-${gradientId}`)}
      </span>
    );
  }

  return (
    <span
      aria-label={label}
      className={className}
      role="img"
      style={style}
    >
      <span className="contents dark:hidden">{renderIcon(`product-icon-${gradientId}-light`)}</span>
      <span
        className="hidden dark:contents"
        style={darkStyle}
      >
        {renderIcon(`product-icon-${gradientId}-dark`)}
      </span>
    </span>
  );
}

function ProductIconSvg({
  product,
  title,
  gradientId
}: {
  product: ProductIconId | (string & {});
  title: string;
  gradientId: string;
}): React.ReactElement {
  if (product === 'claude-code') return <ClaudeCodeIcon title={title} />;
  if (product === 'gemini' || product === 'gemini-cli') {
    return (
      <GeminiCliIcon
        gradientId={gradientId}
        title={title}
      />
    );
  }
  if (product === 'qwen') return <QwenCodeIcon title={title} />;
  return (
    <CodexIcon
      gradientId={gradientId}
      title={title}
    />
  );
}

function CodexIcon({ gradientId, title }: { gradientId: string; title: string }): React.ReactElement {
  return (
    <svg
      height="100%"
      viewBox="0 0 24 24"
      width="100%"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      <defs>
        <linearGradient
          id={gradientId}
          x1="8.72"
          x2="15.47"
          y1="2.72"
          y2="20.95"
        >
          <stop stopColor="var(--product-icon-accent, #B1A7FF)" />
          <stop
            offset="0.5"
            stopColor="var(--product-icon-accent-2, #7A9DFF)"
          />
          <stop
            offset="1"
            stopColor="var(--product-icon-accent-3, #3941FF)"
          />
        </linearGradient>
      </defs>
      <path
        d="M19.503 0H4.496A4.496 4.496 0 0 0 0 4.496v15.007A4.496 4.496 0 0 0 4.496 24h15.007A4.496 4.496 0 0 0 24 19.503V4.496A4.496 4.496 0 0 0 19.503 0z"
        fill="var(--product-icon-bg, #fff)"
      />
      <path
        d="M9.064 3.344a4.578 4.578 0 0 1 2.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 0 0 .043 0 4.55 4.55 0 0 1 3.046.275l.047.022.116.057a4.581 4.581 0 0 1 2.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 0 1-.134 1.223.123.123 0 0 0 .03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 0 1-2.201 1.388.123.123 0 0 0-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 0 0-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 0 1-1.945-.466 4.544 4.544 0 0 1-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 0 1-.37-.961 4.582 4.582 0 0 1-.014-2.298.124.124 0 0 0 .006-.056.085.085 0 0 0-.027-.048 4.467 4.467 0 0 1-1.034-1.651 3.896 3.896 0 0 1-.251-1.192 5.189 5.189 0 0 1 .141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 0 0 .065-.066 4.51 4.51 0 0 1 .829-1.615 4.535 4.535 0 0 1 1.837-1.388zm3.482 10.565a.637.637 0 0 0 0 1.272h3.636a.637.637 0 1 0 0-1.272h-3.636zM8.462 9.23a.637.637 0 0 0-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 1 0 1.095.649l1.454-2.455a.636.636 0 0 0 .005-.64L8.462 9.23z"
        fill={`url(#${gradientId})`}
      />
    </svg>
  );
}

function ClaudeCodeIcon({ title }: { title: string }): React.ReactElement {
  return (
    <svg
      height="100%"
      viewBox="0 0 24 24"
      width="100%"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      <path
        clipRule="evenodd"
        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
        fill="var(--product-icon-accent, #D97757)"
        fillRule="evenodd"
      />
    </svg>
  );
}

function GeminiCliIcon({ gradientId, title }: { gradientId: string; title: string }): React.ReactElement {
  return (
    <svg
      height="100%"
      viewBox="0 0 512 512"
      width="100%"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      <defs>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id={gradientId}
          x1="0"
          x2="512"
          y1="257.869"
          y2="257.869"
        >
          <stop stopColor="var(--product-icon-accent, #217BFE)" />
          <stop
            offset="0.335283"
            stopColor="var(--product-icon-accent-2, #078EFB)"
          />
          <stop
            offset="0.7"
            stopColor="var(--product-icon-accent-3, #AC87EB)"
          />
          <stop
            offset="1"
            stopColor="var(--product-icon-fg, #EE4D5D)"
          />
        </linearGradient>
      </defs>
      <path
        d="M418.569 0H93.4308C41.8304 0 0 41.8304 0 93.4308V418.569C0 470.17 41.8304 512 93.4308 512H418.569C470.17 512 512 470.17 512 418.569V93.4308C512 41.8304 470.17 0 418.569 0Z"
        fill="var(--product-icon-bg, #1E1E2E)"
      />
      <path
        d="M419.776.008C470.82.655 512 42.233 512 93.43v325.142l-.008 1.204C511.344 470.82 469.768 512 418.572 512H93.43C41.83 512 .001 470.168 0 418.572V93.43C.001 42.233 41.179.655 92.223.008L93.43 0h325.142l1.204.008zM93.43 29.898c-35.087.001-63.531 28.444-63.532 63.532v325.142c.001 35.084 28.444 63.528 63.532 63.528h325.142c35.084 0 63.528-28.444 63.528-63.528V93.43c0-35.087-28.444-63.531-63.528-63.532H93.43zm264.496 193.231v78.145l-203.172 97.675v-56.652l166.445-80.098-166.445-80.093v-56.653l203.172 97.676z"
        fill={`url(#${gradientId})`}
      />
    </svg>
  );
}

function QwenCodeIcon({ title }: { title: string }): React.ReactElement {
  return (
    <svg
      height="100%"
      viewBox="0 0 24 24"
      width="100%"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      <path
        d="M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 0 0 .157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 0 0-.081.05 575.097 575.097 0 0 1-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 0 1-.465-.271l-1.335-2.323a.09.09 0 0 0-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 0 1-.002-.54l1.207-2.12a.198.198 0 0 0 0-.197 550.951 550.951 0 0 1-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 0 1 2.589-.001.124.124 0 0 0 .107-.063l2.806-4.895a.488.488 0 0 1 .422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 0 0-.052.03L6.254 6.788a.157.157 0 0 1-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 0 0-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 0 1 .096 0l1.424 2.53a.122.122 0 0 0 .107.062l2.763-.02a.04.04 0 0 0 .035-.02.041.041 0 0 0 0-.04l-2.9-5.086a.108.108 0 0 1 0-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 0 0 0-.114L9.225 1.774a.06.06 0 0 0-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 0 1-.05.029.058.058 0 0 1-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z"
        fill="var(--product-icon-accent, #6336E7)"
      />
    </svg>
  );
}
