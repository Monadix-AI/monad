'use client';

import type { NativeCliStreamView } from './types';

import { useEffect } from 'react';

import { CliTerminalModal } from './CliTerminalModal';

export function NativeCliStreamModal({
  stream,
  onClose,
  onStop
}: {
  stream: NativeCliStreamView;
  onClose: () => void;
  onStop: (id: string) => void;
}): React.ReactElement {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <CliTerminalModal
      icon={stream.icon}
      id={stream.id}
      onClose={onClose}
      onStop={stream.status === 'running' ? () => onStop(stream.id) : undefined}
      output={stream.output}
      status={stream.status}
      subtitle={stream.workingPath}
      tag={stream.tag}
      title={stream.agentName}
    />
  );
}
