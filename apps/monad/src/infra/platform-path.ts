/** The `PATH`-list separator for `platform` (`;` on Windows, `:` elsewhere). Defaults to the live host
 *  so callers that don't need to test other platforms can omit the argument; callers building a launch
 *  spec for an explicit target platform (e.g. a managed-agent runtime) pass it through. */
export function pathDelimiterFor(platform: NodeJS.Platform = process.platform): ';' | ':' {
  return platform === 'win32' ? ';' : ':';
}
