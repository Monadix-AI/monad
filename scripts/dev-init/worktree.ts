export interface MainWorktreeDeps {
  listWorktrees(root: string): Promise<string>;
}

const defaultDeps: MainWorktreeDeps = {
  listWorktrees: async (root) =>
    Bun.$`git worktree list --porcelain`
      .cwd(root)
      .quiet()
      .text()
      .then((text) => text.trim())
      .catch(() => '')
};

export async function findMainWorktreePath(root: string, deps: MainWorktreeDeps = defaultDeps): Promise<string | null> {
  const output = await deps.listWorktrees(root);
  if (!output) return null;

  let currentPath = '';
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim();
    } else if (line === 'branch refs/heads/main' && currentPath && currentPath !== root) {
      return currentPath;
    }
  }
  return null;
}
