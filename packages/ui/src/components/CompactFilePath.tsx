import type { ComponentProps } from 'react';

import { cn } from '../lib/utils';
import { fileBaseName } from './FileIcon';

export type CompactFilePathProps = Omit<ComponentProps<'span'>, 'children'> & {
  path: string;
};

export function CompactFilePath({ className, path, title = path, ...props }: CompactFilePathProps) {
  const fileName = fileBaseName(path);
  const directory = path.slice(0, -fileName.length);

  return (
    <span
      className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center', className)}
      data-slot="compact-file-path"
      title={title}
      {...props}
    >
      <span
        className="min-w-0 truncate"
        data-slot="compact-file-path-directory"
      >
        {directory}
      </span>
      <span
        className="shrink-0"
        data-slot="compact-file-path-filename"
      >
        {fileName}
      </span>
    </span>
  );
}
