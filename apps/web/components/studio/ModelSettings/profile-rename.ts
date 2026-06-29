export type ProfileKeyMap = Record<string, string>;

export function profileKeysForRename(keys: ProfileKeyMap, from: string, to: string): ProfileKeyMap {
  const nextAlias = to.trim();
  if (!nextAlias || nextAlias === from) return keys;
  return { ...keys, [nextAlias]: keys[from] ?? from };
}

export function profileDisplayKey(alias: string, keys: ProfileKeyMap): string {
  return keys[alias] ?? alias;
}
