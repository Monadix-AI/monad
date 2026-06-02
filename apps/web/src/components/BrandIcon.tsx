import type { ChannelIcon } from '@monad/protocol';

import { cn } from '@monad/ui';
import { useId } from 'react';

export function BrandIcon({ className, icon }: { className?: string; icon: ChannelIcon }) {
  const gradientPrefix = useId().replaceAll(':', '');
  const fill = icon.hex ? `#${icon.hex}` : 'currentColor';
  const layers = icon.layers ?? [{ path: icon.path, fill, fillRule: icon.fillRule }];
  return (
    <svg
      aria-hidden="true"
      className={cn('shrink-0', className)}
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
