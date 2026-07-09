'use client';

import { cn } from '@monad/ui';

export type ModelRoleIconId =
  | 'chat'
  | 'embedding'
  | 'fast'
  | 'image'
  | 'memory'
  | 'speech'
  | 'transcription'
  | 'video'
  | 'vision';

const modelRoleIconSrc: Record<ModelRoleIconId, string> = {
  chat: '/model-role-icons/chat.png',
  embedding: '/model-role-icons/embedding.png',
  fast: '/model-role-icons/fast.png',
  image: '/model-role-icons/image.png',
  memory: '/model-role-icons/memory.png',
  speech: '/model-role-icons/speech.png',
  transcription: '/model-role-icons/transcription.png',
  video: '/model-role-icons/video.png',
  vision: '/model-role-icons/vision.png'
};

export function ModelRoleIcon({ className, role }: { className?: string; role: ModelRoleIconId }) {
  return (
    <span
      aria-hidden="true"
      className={cn('block bg-center bg-contain bg-no-repeat', className)}
      style={{ backgroundImage: `url(${modelRoleIconSrc[role]})` }}
    />
  );
}
