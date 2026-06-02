import type { FC, SVGProps } from 'react';

import {
  Audio,
  Biome,
  BracketsYellow,
  Bun,
  CLang,
  CodeBlue,
  CodeOrange,
  Compressed,
  Cplus,
  Csharp,
  Csv,
  Database,
  Docker,
  Document,
  Font,
  Gif,
  Git,
  Go,
  Graphql,
  Image,
  Java,
  Js,
  Kotlin,
  Lua,
  Markdown,
  MDX,
  NPM,
  PDF,
  PHP,
  Python,
  Reactjs,
  Reactts,
  Ruby,
  Rust,
  Shell,
  SVG,
  Svelte,
  Swift,
  Text,
  Tsconfig,
  TypeScript,
  Video,
  Vue,
  XML,
  Yaml,
  Zip
} from '@react-symbols/icons/files';

export type FilePreviewKind = 'image' | 'text' | 'unsupported';

export type FileIconProps = {
  className?: string;
  contentType?: string;
  fileName: string;
  preview?: FilePreviewKind;
};

const MIME_FILE_NAMES: Readonly<Record<string, string>> = {
  'application/gzip': 'file.tar.gz',
  'application/javascript': 'file.js',
  'application/json': 'file.json',
  'application/pdf': 'file.pdf',
  'application/sql': 'file.sql',
  'application/toml': 'file.toml',
  'application/typescript': 'file.ts',
  'application/x-7z-compressed': 'file.7z',
  'application/x-rar-compressed': 'file.rar',
  'application/x-tar': 'file.tar',
  'application/xml': 'file.xml',
  'application/yaml': 'file.yaml',
  'application/zip': 'file.zip',
  'audio/mpeg': 'file.mp3',
  'audio/wav': 'file.wav',
  'image/jpeg': 'file.jpg',
  'image/svg+xml': 'file.svg',
  'text/css': 'file.css',
  'text/csv': 'file.csv',
  'text/html': 'file.html',
  'text/javascript': 'file.js',
  'text/markdown': 'file.md',
  'text/plain': 'file.txt',
  'text/typescript': 'file.ts',
  'text/xml': 'file.xml',
  'text/yaml': 'file.yaml',
  'video/quicktime': 'file.mov'
};

type FileSymbol = FC<SVGProps<SVGSVGElement>>;

const FILE_NAME_SYMBOLS: Readonly<Record<string, FileSymbol>> = {
  '.gitignore': Git,
  'biome.json': Biome,
  'biome.jsonc': Biome,
  'bun.lock': Bun,
  'bun.lockb': Bun,
  dockerfile: Docker,
  'package.json': NPM,
  'tsconfig.json': Tsconfig
};

const EXTENSION_SYMBOLS: Readonly<Record<string, FileSymbol>> = {
  '7z': Zip,
  aac: Audio,
  avi: Video,
  bash: Shell,
  bmp: Image,
  bz2: Compressed,
  c: CLang,
  cc: Cplus,
  cpp: Cplus,
  cs: Csharp,
  css: CodeBlue,
  csv: Csv,
  db: Database,
  gif: Gif,
  go: Go,
  gql: Graphql,
  graphql: Graphql,
  gz: Compressed,
  html: CodeOrange,
  java: Java,
  jpeg: Image,
  jpg: Image,
  js: Js,
  json: BracketsYellow,
  jsonc: BracketsYellow,
  jsonl: BracketsYellow,
  jsx: Reactjs,
  kt: Kotlin,
  kts: Kotlin,
  lua: Lua,
  m4a: Audio,
  m4v: Video,
  md: Markdown,
  mdx: MDX,
  mov: Video,
  mp3: Audio,
  mp4: Video,
  ogg: Audio,
  otf: Font,
  pdf: PDF,
  php: PHP,
  png: Image,
  py: Python,
  rar: Zip,
  rb: Ruby,
  rs: Rust,
  sh: Shell,
  sqlite: Database,
  sqlite3: Database,
  svg: SVG,
  svelte: Svelte,
  swift: Swift,
  tar: Compressed,
  tgz: Compressed,
  toml: BracketsYellow,
  ts: TypeScript,
  tsv: Csv,
  tsx: Reactts,
  ttf: Font,
  txt: Text,
  vue: Vue,
  wav: Audio,
  webm: Video,
  webp: Image,
  woff: Font,
  woff2: Font,
  xls: Csv,
  xlsx: Csv,
  xml: XML,
  xz: Compressed,
  yaml: Yaml,
  yml: Yaml,
  zip: Zip,
  zsh: Shell
};

function baseName(fileName: string): string {
  return fileName.split(/[\\/]/).pop() || fileName;
}

function extension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot + 1).toLowerCase() : '';
}

function hasFileExtension(fileName: string): boolean {
  return extension(fileName) !== '';
}

export function fileIconName({ contentType, fileName, preview }: Omit<FileIconProps, 'className'>): string {
  const name = baseName(fileName);
  if (hasFileExtension(name) || (name && !contentType)) return name;

  const type = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (type && MIME_FILE_NAMES[type]) return MIME_FILE_NAMES[type];
  if (type?.startsWith('image/') || preview === 'image') return `file.${type?.slice(6) || 'png'}`;
  if (type?.startsWith('audio/')) return `file.${type.slice(6)}`;
  if (type?.startsWith('video/')) return `file.${type.slice(6)}`;
  if (type?.startsWith('text/') || preview === 'text') return 'file.txt';
  return name || 'file';
}

function fileSymbol(fileName: string): FileSymbol {
  const name = baseName(fileName).toLowerCase();
  return FILE_NAME_SYMBOLS[name] ?? EXTENSION_SYMBOLS[extension(name)] ?? Document;
}

export function FileIcon({ className, contentType, fileName, preview }: FileIconProps) {
  const iconName = fileIconName({ contentType, fileName, preview });
  const FileSymbolIcon = fileSymbol(iconName);
  return (
    <FileSymbolIcon
      aria-hidden="true"
      className={className}
      data-file-icon={iconName}
    />
  );
}
