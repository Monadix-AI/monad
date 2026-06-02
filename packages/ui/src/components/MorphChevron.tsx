import type { CSSProperties } from 'react';

import { motion, useReducedMotion } from 'motion/react';

import { cn } from '../lib/utils';

const DOWN_PATH = 'M6 9L12 15L18 9';
const UP_PATH = 'M6 15L12 9L18 15';

export interface MorphChevronProps {
  className?: string;
  expanded: boolean;
  size?: number | string;
  strokeWidth?: number;
  style?: CSSProperties;
}

export function MorphChevron({ className, expanded, size = 16, strokeWidth = 2, style }: MorphChevronProps) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.svg
      aria-hidden="true"
      className={cn('shrink-0', className)}
      data-expanded={expanded}
      fill="none"
      focusable="false"
      height={size}
      style={style}
      viewBox="0 0 24 24"
      width={size}
    >
      <motion.path
        animate={{ d: expanded ? UP_PATH : DOWN_PATH }}
        initial={false}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
        transition={reduceMotion ? { duration: 0 } : { duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      />
    </motion.svg>
  );
}
