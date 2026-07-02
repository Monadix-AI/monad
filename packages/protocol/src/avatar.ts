const AVATAR_CACHE_VERSION = 'v1';

export function avatarCacheKey(seed: string): string {
  let hash = 5381;
  const input = `${AVATAR_CACHE_VERSION}:${seed}`;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

export function entityAvatarUrl(seed: string): string {
  const key = avatarCacheKey(seed);
  return `/api/avatar-cache/${key}.svg?seed=${encodeURIComponent(seed)}`;
}

export function entityAvatarWriteUrl(seed: string): string {
  return `${entityAvatarUrl(seed)}&write=1`;
}
