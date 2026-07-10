'use client';

import type { Area, Point } from 'react-easy-crop';

import { Delete02Icon, LoaderPinwheelIcon, PencilEdit02Icon, Upload01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useGetAppearanceQuery, useGetProfileSettingsQuery, useSetProfileSettingsMutation } from '@monad/client-rtk';
import { DEFAULT_AVATAR_STYLE, entityAvatarUrl, entityAvatarWriteUrl } from '@monad/protocol';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Skeleton
} from '@monad/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import Cropper from 'react-easy-crop';
import 'react-easy-crop/react-easy-crop.css';

import { useT } from '#/components/I18nProvider';

const MAX_AVATAR_BYTES = 512 * 1024;
const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const DISPLAY_NAME_MAX_LENGTH = 80;
const AVATAR_OUTPUT_SIZE = 512;

function ProfileSettingsSkeleton() {
  return (
    <div
      aria-busy="true"
      className="flex min-h-full flex-1 items-center justify-center overflow-y-auto px-4 py-8 sm:px-6"
    >
      <section className="flex w-full max-w-md flex-col items-center rounded-xl border border-border/70 bg-card p-7 text-center">
        <Skeleton className="size-32 rounded-full" />
        <Skeleton className="mt-6 h-7 w-48 rounded-md" />
        <Skeleton className="mt-3 h-4 w-28 rounded" />
      </section>
    </div>
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('avatar read failed'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('avatar crop failed'));
    image.src = src;
  });
}

async function cropImageToSquareDataUrl(src: string, area: Area): Promise<string> {
  const image = await loadImage(src);
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_OUTPUT_SIZE;
  canvas.height = AVATAR_OUTPUT_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('avatar crop failed');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);
  return canvas.toDataURL('image/webp', 0.92);
}

export function ProfileSettings() {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const { data, isLoading } = useGetProfileSettingsQuery();
  const { data: appearance } = useGetAppearanceQuery();
  const [setProfile, { isLoading: isSaving }] = useSetProfileSettingsMutation();
  const [displayName, setDisplayName] = useState('');
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [cropSource, setCropSource] = useState<string | null>(null);
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedArea, setCroppedArea] = useState<Area | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'saving'>('idle');
  const avatarStyle = appearance?.avatarStyle ?? DEFAULT_AVATAR_STYLE;
  const trimmedName = displayName.trim();
  const generatedAvatarSeed = `user:${trimmedName || data?.displayName || 'Operator'}`;
  const generatedAvatarUrl = entityAvatarUrl(generatedAvatarSeed, avatarStyle);
  const previewName = trimmedName || data?.displayName || 'Operator';
  const avatarUrl = avatarDataUrl ?? generatedAvatarUrl;

  const persistProfile = useCallback(
    async (nextName: string, nextAvatarDataUrl: string | null) => {
      const name = nextName.trim();
      if (!name) {
        setError(t('web.settings.profile.displayNameRequired'));
        return;
      }
      setError(null);
      setSaveState('saving');
      try {
        await setProfile({ displayName: name, avatarDataUrl: nextAvatarDataUrl }).unwrap();
        if (!nextAvatarDataUrl) {
          void fetch(entityAvatarWriteUrl(`user:${name}`, avatarStyle), { method: 'POST' }).catch(() => {});
        }
        setSaveState('saved');
      } catch (err) {
        setSaveState('idle');
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [avatarStyle, setProfile, t]
  );

  useEffect(() => {
    if (!data) return;
    setDisplayName(data.displayName);
    setAvatarDataUrl(data.avatarDataUrl);
    setError(null);
    setSaveState('saved');
  }, [data]);

  useEffect(() => {
    if (!editingName) return;
    window.setTimeout(() => nameInputRef.current?.focus(), 0);
  }, [editingName]);

  useEffect(() => {
    if (!data) return;
    if (!trimmedName || trimmedName === data.displayName) return;
    const timer = window.setTimeout(() => void persistProfile(trimmedName, avatarDataUrl), 550);
    return () => window.clearTimeout(timer);
  }, [avatarDataUrl, data, persistProfile, trimmedName]);

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
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedArea(null);
    setCropSource(await readFileAsDataUrl(file));
  }

  async function applyCrop() {
    if (!cropSource || !croppedArea) return;
    try {
      const nextAvatar = await cropImageToSquareDataUrl(cropSource, croppedArea);
      setAvatarDataUrl(nextAvatar);
      setCropSource(null);
      if (inputRef.current) inputRef.current.value = '';
      await persistProfile(previewName, nextAvatar);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeAvatar() {
    setAvatarDataUrl(null);
    if (inputRef.current) inputRef.current.value = '';
    await persistProfile(previewName, null);
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {isLoading && !data ? (
        <ProfileSettingsSkeleton />
      ) : (
        <div className="flex min-h-full flex-1 items-center justify-center overflow-y-auto px-4 py-8 sm:px-6">
          <section className="relative flex w-full max-w-md flex-col items-center overflow-hidden rounded-xl border border-border/70 bg-card px-6 py-8 text-center shadow-[0_10px_28px_-24px_rgba(15,23,42,0.5)] sm:px-8">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-[radial-gradient(circle_at_50%_0%,color-mix(in_srgb,var(--accent)_22%,transparent),transparent_58%)]"
            />

            <input
              accept={AVATAR_ACCEPT}
              className="hidden"
              onChange={(event) => void handleAvatar(event.currentTarget.files?.[0])}
              ref={inputRef}
              type="file"
            />

            <button
              aria-label={t('web.settings.profile.avatarEdit')}
              className="group relative z-10 flex size-32 items-center justify-center rounded-full border border-border/70 bg-muted p-1 outline-none transition-[border-color,box-shadow,transform] duration-150 hover:border-ring focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 active:scale-[0.99]"
              disabled={isLoading || isSaving}
              onClick={() => inputRef.current?.click()}
              type="button"
            >
              <span className="relative size-full overflow-hidden rounded-full bg-background">
                <span
                  aria-hidden="true"
                  className="absolute inset-0 bg-center bg-cover"
                  style={{ backgroundImage: `url(${avatarUrl})` }}
                />
                <span className="absolute inset-x-0 bottom-0 flex translate-y-full items-center justify-center gap-1 bg-background/88 px-2 py-2 font-medium text-[11px] text-foreground backdrop-blur-sm transition-transform duration-150 group-hover:translate-y-0 group-focus-visible:translate-y-0 [@media_(hover:none),_(pointer:coarse)]:translate-y-0">
                  <HugeiconsIcon
                    aria-hidden
                    className="size-3.5"
                    icon={PencilEdit02Icon}
                  />
                  {t('web.settings.profile.avatarEditShort')}
                </span>
              </span>
            </button>

            <div className="relative z-10 mt-6 flex min-h-10 w-full items-center justify-center">
              {editingName ? (
                <Input
                  aria-invalid={Boolean(error)}
                  aria-label={t('web.settings.profile.displayName')}
                  className="h-10 max-w-72 text-center font-semibold text-lg"
                  maxLength={DISPLAY_NAME_MAX_LENGTH}
                  onBlur={() => {
                    setEditingName(false);
                    if (!trimmedName && data) setDisplayName(data.displayName);
                  }}
                  onChange={(event) => setDisplayName(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                    if (event.key === 'Escape' && data) {
                      setDisplayName(data.displayName);
                      event.currentTarget.blur();
                    }
                  }}
                  ref={nameInputRef}
                  value={displayName}
                />
              ) : (
                <button
                  className="max-w-full truncate rounded-xs px-1 font-semibold text-2xl leading-8 underline-offset-4 outline-none transition-[color,text-decoration-color,box-shadow] duration-150 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/30"
                  onClick={() => setEditingName(true)}
                  type="button"
                >
                  {previewName}
                </button>
              )}
            </div>

            <div className="relative z-10 mt-2 flex h-5 items-center justify-center gap-1.5 text-muted-foreground text-xs">
              {isSaving || saveState === 'saving' ? (
                <>
                  <HugeiconsIcon
                    aria-hidden
                    className="size-3.5 animate-spin"
                    icon={LoaderPinwheelIcon}
                  />
                  {t('web.settings.profile.saving')}
                </>
              ) : (
                t('web.settings.profile.saved')
              )}
            </div>

            {avatarDataUrl ? (
              <Button
                className="relative z-10 mt-5 gap-2"
                disabled={isLoading || isSaving}
                onClick={() => void removeAvatar()}
                size="sm"
                variant="ghost"
              >
                <HugeiconsIcon
                  aria-hidden
                  className="size-4"
                  icon={Delete02Icon}
                />
                {t('web.settings.profile.avatarRemove')}
              </Button>
            ) : null}

            {error ? (
              <p
                className="relative z-10 mt-5 w-full rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2 text-destructive text-xs"
                id="profile-error"
                role="alert"
              >
                {error}
              </p>
            ) : null}
          </section>
        </div>
      )}

      <Dialog
        onOpenChange={(open) => {
          if (!open) setCropSource(null);
        }}
        open={Boolean(cropSource)}
      >
        <DialogContent className="max-w-[calc(100%-2rem)] gap-5 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('web.settings.profile.cropAvatar')}</DialogTitle>
            <DialogDescription>{t('web.settings.profile.cropAvatarDesc')}</DialogDescription>
          </DialogHeader>

          <div className="relative h-72 overflow-hidden rounded-lg border border-border bg-muted">
            {cropSource ? (
              <Cropper
                aspect={1}
                crop={crop}
                cropShape="round"
                image={cropSource}
                onCropChange={setCrop}
                onCropComplete={(_, areaPixels) => setCroppedArea(areaPixels)}
                onZoomChange={setZoom}
                showGrid={false}
                zoom={zoom}
              />
            ) : null}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="profile-avatar-zoom">{t('web.settings.profile.avatarZoom')}</Label>
            <input
              className="h-8 w-full accent-primary"
              id="profile-avatar-zoom"
              max={3}
              min={1}
              onChange={(event) => setZoom(Number(event.currentTarget.value))}
              step={0.01}
              type="range"
              value={zoom}
            />
          </div>

          <DialogFooter>
            <Button
              onClick={() => setCropSource(null)}
              type="button"
              variant="outline"
            >
              {t('web.cancel')}
            </Button>
            <Button
              className="gap-2"
              disabled={!croppedArea || isSaving}
              onClick={() => void applyCrop()}
              type="button"
            >
              <HugeiconsIcon
                aria-hidden
                className="size-4"
                icon={Upload01Icon}
              />
              {t('web.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
