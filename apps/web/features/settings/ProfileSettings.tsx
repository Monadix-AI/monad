'use client';

import {
  Cancel01Icon,
  Delete02Icon,
  LoaderPinwheelIcon,
  Upload01Icon,
  UserGroupIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useGetAppearanceQuery, useGetProfileSettingsQuery, useSetProfileSettingsMutation } from '@monad/client-rtk';
import { DEFAULT_AVATAR_STYLE, entityAvatarUrl, entityAvatarWriteUrl } from '@monad/protocol';
import { Button, Input, Label } from '@monad/ui';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';

import { useT } from '@/components/I18nProvider';

const MAX_AVATAR_BYTES = 512 * 1024;
const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

interface Props {
  onClose: () => void;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('avatar read failed'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  });
}

export function ProfileSettings({ onClose }: Props) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const { data, isLoading } = useGetProfileSettingsQuery();
  const { data: appearance } = useGetAppearanceQuery();
  const [setProfile, { isLoading: isSaving }] = useSetProfileSettingsMutation();
  const [displayName, setDisplayName] = useState('');
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(null);
  const avatarStyle = appearance?.avatarStyle ?? DEFAULT_AVATAR_STYLE;
  const [error, setError] = useState<string | null>(null);
  const trimmedName = displayName.trim();
  const changed = data ? trimmedName !== data.displayName || avatarDataUrl !== data.avatarDataUrl : false;
  const generatedAvatarSeed = `user:${trimmedName || data?.displayName || 'Operator'}`;
  const generatedAvatarUrl = entityAvatarUrl(generatedAvatarSeed, avatarStyle);

  useEffect(() => {
    if (!data) return;
    setDisplayName(data.displayName);
    setAvatarDataUrl(data.avatarDataUrl);
    setError(null);
  }, [data]);

  async function handleAvatar(file: File | undefined) {
    if (!file) return;
    if (!AVATAR_ACCEPT.split(',').includes(file.type)) {
      setError(t('web.settings.profile.avatarTypeError'));
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setError(t('web.settings.profile.avatarSizeError'));
      return;
    }
    setError(null);
    setAvatarDataUrl(await readFileAsDataUrl(file));
  }

  async function handleSave() {
    if (!trimmedName) {
      setError(t('web.settings.profile.displayNameRequired'));
      return;
    }
    setError(null);
    try {
      await setProfile({ displayName: trimmedName, avatarDataUrl }).unwrap();
      if (!avatarDataUrl)
        void fetch(entityAvatarWriteUrl(`user:${trimmedName}`, avatarStyle), { method: 'POST' }).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            className="size-4 text-muted-foreground"
            icon={UserGroupIcon}
          />
          <span className="font-semibold text-sm">{t('web.settings.profile')}</span>
        </div>
        <Button
          aria-label={t('web.close')}
          className="size-7"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <HugeiconsIcon icon={Cancel01Icon} />
        </Button>
      </div>

      <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-6">
        <p className="text-muted-foreground text-sm">{t('web.settings.profileDesc')}</p>

        <section className="flex flex-col gap-3">
          <h3 className="font-semibold text-sm">{t('web.settings.profile.avatar')}</h3>
          <div className="flex items-center gap-4">
            <div className="relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-muted font-semibold text-lg">
              {avatarDataUrl ? (
                <Image
                  alt=""
                  className="size-full object-cover"
                  fill
                  src={avatarDataUrl}
                />
              ) : (
                <Image
                  alt=""
                  className="size-full object-cover"
                  fill
                  src={generatedAvatarUrl}
                  unoptimized
                />
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(event) => void handleAvatar(event.currentTarget.files?.[0])}
                ref={inputRef}
                type="file"
              />
              <Button
                className="gap-2"
                disabled={isLoading || isSaving}
                onClick={() => inputRef.current?.click()}
                size="sm"
                variant="secondary"
              >
                <HugeiconsIcon
                  className="size-4"
                  icon={Upload01Icon}
                />
                {t('web.settings.profile.avatarUpload')}
              </Button>
              <Button
                className="gap-2"
                disabled={isLoading || isSaving || !avatarDataUrl}
                onClick={() => {
                  setAvatarDataUrl(null);
                  if (inputRef.current) inputRef.current.value = '';
                }}
                size="sm"
                variant="ghost"
              >
                <HugeiconsIcon
                  className="size-4"
                  icon={Delete02Icon}
                />
                {t('web.settings.profile.avatarRemove')}
              </Button>
            </div>
          </div>
        </section>

        <section className="flex max-w-md flex-col gap-2">
          <Label htmlFor="profile-display-name">{t('web.settings.profile.displayName')}</Label>
          <Input
            disabled={isLoading || isSaving}
            id="profile-display-name"
            maxLength={80}
            onChange={(event) => setDisplayName(event.currentTarget.value)}
            value={displayName}
          />
        </section>

        {error && <p className="text-destructive text-xs">{error}</p>}

        <div className="flex justify-end">
          <Button
            className="gap-2"
            disabled={isLoading || isSaving || !changed}
            onClick={() => void handleSave()}
          >
            {isSaving && (
              <HugeiconsIcon
                className="size-4 animate-spin"
                icon={LoaderPinwheelIcon}
              />
            )}
            {t('web.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
