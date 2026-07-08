import type { ComponentProps } from 'react';

import { Image01Icon, MonitorDotIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useCallback } from 'react';

import { DropdownMenuItem } from '#/components/ui/dropdown-menu';
import { usePromptInputAttachments } from './prompt-input-context';

const captureScreenshot = async (): Promise<File | null> => {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
    return null;
  }

  let stream: MediaStream | null = null;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: true
    });

    video.srcObject = stream;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Failed to load screen stream'));
    });

    await video.play();

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }

    context.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png');
    });
    if (!blob) {
      return null;
    }

    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-').replace('T', '_').replace('Z', '');

    return new File([blob], `screenshot-${timestamp}.png`, {
      lastModified: Date.now(),
      type: 'image/png'
    });
  } finally {
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
    video.pause();
    video.srcObject = null;
  }
};

export type PromptInputActionAddAttachmentsProps = ComponentProps<typeof DropdownMenuItem> & {
  label?: string;
};

export const PromptInputActionAddAttachments = ({
  label = 'Add photos or files',
  ...props
}: PromptInputActionAddAttachmentsProps) => {
  const attachments = usePromptInputAttachments();

  const handleSelect = useCallback(
    (e: Event) => {
      e.preventDefault();
      attachments.openFileDialog();
    },
    [attachments]
  );

  return (
    <DropdownMenuItem
      {...props}
      onSelect={handleSelect}
    >
      <HugeiconsIcon
        className="mr-2 size-4"
        icon={Image01Icon}
      />{' '}
      {label}
    </DropdownMenuItem>
  );
};

export type PromptInputActionAddScreenshotProps = ComponentProps<typeof DropdownMenuItem> & {
  label?: string;
};

export const PromptInputActionAddScreenshot = ({
  label = 'Take screenshot',
  onSelect,
  ...props
}: PromptInputActionAddScreenshotProps) => {
  const attachments = usePromptInputAttachments();

  const handleSelect = useCallback(
    async (event: Event) => {
      onSelect?.(event);
      if (event.defaultPrevented) {
        return;
      }

      try {
        const screenshot = await captureScreenshot();
        if (screenshot) {
          attachments.add([screenshot]);
        }
      } catch (error) {
        if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
          return;
        }
        throw error;
      }
    },
    [onSelect, attachments]
  );

  return (
    <DropdownMenuItem
      {...props}
      onSelect={handleSelect}
    >
      <HugeiconsIcon
        className="mr-2 size-4"
        icon={MonitorDotIcon}
      />
      {label}
    </DropdownMenuItem>
  );
};
