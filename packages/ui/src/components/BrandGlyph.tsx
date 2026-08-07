import type { CSSProperties } from 'react';

import { useId } from 'react';

import { cn } from '../lib/utils';

/**
 * Presentation shape of a brand mark: the multi-layer SVG description an atom pack ships for its
 * channel. Declared here rather than imported because this package must not depend on the data
 * layer; every producer's icon type is structurally assignable to it.
 */
export interface BrandGlyphGradientStop {
  offset: number | string;
  color: string;
  opacity?: number;
}

export interface BrandGlyphGradient {
  id: string;
  type: 'linear' | 'radial';
  stops: readonly BrandGlyphGradientStop[];
  x1?: number;
  x2?: number;
  y1?: number;
  y2?: number;
  cx?: number;
  cy?: number;
  fx?: number;
  fy?: number;
  r?: number;
}

export interface BrandGlyphLayer {
  path: string;
  fill?: string;
  fillRule?: 'nonzero' | 'evenodd' | 'inherit';
  gradient?: string;
  opacity?: number;
  stroke?: string;
  strokeLinecap?: 'butt' | 'round' | 'square' | 'inherit';
  strokeLinejoin?: 'miter' | 'round' | 'bevel' | 'inherit';
  strokeWidth?: number;
  transform?: string;
}

export interface BrandGlyphIcon {
  path?: string;
  fillRule?: 'nonzero' | 'evenodd' | 'inherit';
  hex?: string;
  viewBox?: readonly number[];
  layers?: readonly BrandGlyphLayer[];
  gradients?: readonly BrandGlyphGradient[];
}

/** Renders a brand mark. Gradient ids are namespaced per instance so two marks never collide. */
export function BrandGlyph({
  className,
  icon,
  style
}: {
  className?: string;
  icon: BrandGlyphIcon;
  style?: CSSProperties;
}) {
  const gradientPrefix = useId().replaceAll(':', '');
  const fill = icon.hex ? `#${icon.hex}` : 'currentColor';
  const layers = icon.layers ?? [{ path: icon.path ?? '', fill, fillRule: icon.fillRule }];
  return (
    <svg
      aria-hidden="true"
      className={cn('shrink-0', className)}
      style={style}
      viewBox={(icon.viewBox ?? [0, 0, 24, 24]).join(' ')}
    >
      {icon.gradients ? (
        <defs>
          {icon.gradients.map((gradient) => {
            const stops = gradient.stops.map((stop) => (
              <stop
                key={`${stop.offset}:${stop.color}`}
                offset={stop.offset}
                stopColor={stop.color}
                stopOpacity={stop.opacity}
              />
            ));
            const id = `${gradientPrefix}-${gradient.id}`;
            return gradient.type === 'linear' ? (
              <linearGradient
                gradientUnits="userSpaceOnUse"
                id={id}
                key={gradient.id}
                x1={gradient.x1}
                x2={gradient.x2}
                y1={gradient.y1}
                y2={gradient.y2}
              >
                {stops}
              </linearGradient>
            ) : (
              <radialGradient
                cx={gradient.cx}
                cy={gradient.cy}
                fx={gradient.fx}
                fy={gradient.fy}
                gradientUnits="userSpaceOnUse"
                id={id}
                key={gradient.id}
                r={gradient.r}
              >
                {stops}
              </radialGradient>
            );
          })}
        </defs>
      ) : null}
      {layers.map((layer) => (
        <path
          d={layer.path}
          fill={layer.gradient ? `url(#${gradientPrefix}-${layer.gradient})` : (layer.fill ?? fill)}
          fillRule={layer.fillRule}
          key={`${layer.gradient ?? layer.fill ?? fill}:${layer.transform ?? ''}:${layer.path}`}
          opacity={layer.opacity}
          stroke={layer.stroke}
          strokeLinecap={layer.strokeLinecap}
          strokeLinejoin={layer.strokeLinejoin}
          strokeWidth={layer.strokeWidth}
          transform={layer.transform}
        />
      ))}
    </svg>
  );
}
