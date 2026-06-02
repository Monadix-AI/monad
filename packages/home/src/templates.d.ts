// `import … with { type: 'file' }` yields the on-disk path in dev and the embedded
// $bunfs path in a `bun build --compile` binary — read it with `Bun.file`.
declare module '*.md' {
  const path: string;
  export default path;
}
