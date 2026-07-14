import {
  BracesIcon,
  ComputerTerminal01Icon,
  DatabaseIcon,
  File01Icon,
  FileArchiveIcon,
  FileAudioIcon,
  FileBracesIcon,
  FileCodeIcon,
  FileCogIcon,
  FileImageIcon,
  FileLockIcon,
  FileSpreadsheetIcon,
  FileTypeIcon,
  FileVideoIcon,
  FileXIcon,
  Settings02Icon,
  TextIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';

type FilePreviewKind = 'image' | 'text' | 'unsupported';

type FileIconInput = {
  contentType?: string;
  fileName: string;
  preview?: FilePreviewKind;
};

const codeExtensions = new Set([
  'c',
  'cc',
  'cpp',
  'cs',
  'css',
  'go',
  'html',
  'java',
  'js',
  'jsx',
  'kt',
  'lua',
  'mjs',
  'php',
  'rb',
  'rs',
  'swift',
  'ts',
  'tsx'
]);

const textExtensions = new Set(['log', 'md', 'mdx', 'rst', 'text', 'txt']);
const shellExtensions = new Set(['bash', 'fish', 'ps1', 'sh', 'zsh']);
const dataExtensions = new Set(['csv', 'db', 'sqlite', 'sqlite3', 'tsv']);
const archiveExtensions = new Set(['7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'xz', 'zip']);
const imageExtensions = new Set(['apng', 'avif', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const audioExtensions = new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav']);
const videoExtensions = new Set(['avi', 'm4v', 'mov', 'mp4', 'webm']);
const fontExtensions = new Set(['otf', 'ttf', 'woff', 'woff2']);
const spreadsheetExtensions = new Set(['ods', 'xls', 'xlsx']);
const configNames = new Set([
  '.env',
  '.env.local',
  '.gitignore',
  'biome.json',
  'bun.lock',
  'dockerfile',
  'package.json',
  'tsconfig.json'
]);

function extensionOf(fileName: string): string {
  const baseName = fileName.split('/').pop()?.toLowerCase() ?? fileName.toLowerCase();
  const dot = baseName.lastIndexOf('.');
  return dot > 0 ? baseName.slice(dot + 1) : '';
}

function getFileIconForName({ contentType, fileName, preview }: FileIconInput): IconSvgElement {
  const baseName = fileName.split('/').pop()?.toLowerCase() ?? fileName.toLowerCase();
  const ext = extensionOf(fileName);
  const type = contentType?.toLowerCase() ?? '';

  if (baseName === 'skill.md') return TextIcon;
  if (configNames.has(baseName)) return Settings02Icon;
  if (preview === 'unsupported') return FileXIcon;
  if (preview === 'image' || type.startsWith('image/') || imageExtensions.has(ext)) return FileImageIcon;
  if (type.startsWith('audio/') || audioExtensions.has(ext)) return FileAudioIcon;
  if (type.startsWith('video/') || videoExtensions.has(ext)) return FileVideoIcon;
  if (archiveExtensions.has(ext)) return FileArchiveIcon;
  if (fontExtensions.has(ext)) return FileTypeIcon;
  if (spreadsheetExtensions.has(ext)) return FileSpreadsheetIcon;
  if (dataExtensions.has(ext)) return DatabaseIcon;
  if (shellExtensions.has(ext)) return ComputerTerminal01Icon;
  if (ext === 'json' || ext === 'jsonc' || ext === 'jsonl') return FileBracesIcon;
  if (ext === 'yaml' || ext === 'yml' || ext === 'toml') return BracesIcon;
  if (baseName.includes('secret') || baseName.includes('credential') || baseName.includes('key')) return FileLockIcon;
  if (codeExtensions.has(ext)) return FileCodeIcon;
  if (preview === 'text' || type.startsWith('text/') || textExtensions.has(ext)) return TextIcon;
  if (baseName.endsWith('config')) return FileCogIcon;
  return File01Icon;
}

export function FileIcon({
  className,
  contentType,
  fileName,
  preview
}: FileIconInput & {
  className?: string;
}) {
  const Icon = getFileIconForName({ contentType, fileName, preview });
  return (
    <HugeiconsIcon
      className={className}
      icon={Icon}
    />
  );
}
