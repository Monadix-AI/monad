export type DependencyKind = 'development' | 'runtime';

export interface WorkspacePackage {
  dependencies: string[];
  devDependencies: string[];
  dir: string;
  name: string;
}

export interface AllowedAppDependency {
  from: string;
  kind: DependencyKind;
  reason: string;
  to: string;
}

export interface DependencyPolicy {
  allowedAppDependencies: AllowedAppDependency[];
}

export interface DependencyViolation {
  dependencyKind: DependencyKind;
  from: string;
  fromDir: string;
  to: string;
  toDir: string;
}

export const defaultDependencyPolicy: DependencyPolicy = {
  allowedAppDependencies: [
    {
      from: '@monad/cli',
      kind: 'runtime',
      reason: 'The CLI is the release composition root for the daemon process.',
      to: '@monad/monad'
    },
    {
      from: '@monad/cli',
      kind: 'runtime',
      reason: 'The CLI exposes the terminal UI command surface.',
      to: '@monad/tui'
    },
    {
      from: '@monad/cli',
      kind: 'runtime',
      reason: 'The CLI mounts and launches the bundled web application.',
      to: '@monad/web'
    },
    {
      from: '@monad/web',
      kind: 'development',
      reason: 'The development server derives its daemon route type from the daemon public API.',
      to: '@monad/monad'
    }
  ]
};

function isApp(pkg: WorkspacePackage): boolean {
  return pkg.dir.startsWith('apps/');
}

function isAllowed(policy: DependencyPolicy, from: string, to: string, kind: DependencyKind): boolean {
  return policy.allowedAppDependencies.some((edge) => edge.from === from && edge.to === to && edge.kind === kind);
}

export function checkDependencyDirections(
  packages: WorkspacePackage[],
  policy: DependencyPolicy
): DependencyViolation[] {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const violations: DependencyViolation[] = [];

  for (const pkg of packages) {
    const edges: Array<{ dependencies: string[]; kind: DependencyKind }> = [
      { dependencies: pkg.dependencies, kind: 'runtime' },
      { dependencies: pkg.devDependencies, kind: 'development' }
    ];
    for (const { dependencies, kind } of edges) {
      for (const dependency of dependencies) {
        const target = byName.get(dependency);
        if (!target || !isApp(target) || isAllowed(policy, pkg.name, target.name, kind)) continue;
        violations.push({
          dependencyKind: kind,
          from: pkg.name,
          fromDir: pkg.dir,
          to: target.name,
          toDir: target.dir
        });
      }
    }
  }

  return violations;
}
