const syncpackStaged = (files) => {
  const sources = files.map((file) => `--source=${file}`).join(' ');
  return [`syncpack format ${sources}`, `syncpack lint ${sources}`];
};

export default {
  '*': 'biome check --write --unsafe --error-on-warnings --files-ignore-unknown=true --no-errors-on-unmatched',
  '*.{ts,tsx}': () => 'turbo run typecheck --filter=[HEAD] --output-logs=errors-only',
  '**/package.json': syncpackStaged
};
