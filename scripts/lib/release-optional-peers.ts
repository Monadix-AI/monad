interface PackageManifest {
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function optionalPeerExternals(manifestPath: string): Promise<string[]> {
  let manifest: PackageManifest;
  try {
    manifest = (await Bun.file(manifestPath).json()) as PackageManifest;
  } catch (error) {
    throw new Error(`could not read optional peers from ${manifestPath}`, { cause: error });
  }
  const { peerDependencies, peerDependenciesMeta } = manifest;
  if (!isRecord(peerDependencies) || !isRecord(peerDependenciesMeta)) {
    throw new Error(`optional peer metadata is missing from ${manifestPath}`);
  }
  return Object.entries(peerDependenciesMeta)
    .filter(([name, metadata]) => isRecord(metadata) && metadata.optional === true && name in peerDependencies)
    .map(([name]) => name)
    .sort();
}
