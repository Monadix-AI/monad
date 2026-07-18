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

export type FilePreviewKind = 'image' | 'text' | 'unsupported';
export type FileIconKind =
  | 'archive'
  | 'audio'
  | 'code'
  | 'config'
  | 'data'
  | 'file'
  | 'font'
  | 'image'
  | 'locked'
  | 'spreadsheet'
  | 'text'
  | 'unsupported'
  | 'video';

export type FileIconProps = {
  className?: string;
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

function fileIcon(input: Omit<FileIconProps, 'className'>): { icon: IconSvgElement; kind: FileIconKind } {
  const baseName = input.fileName.split('/').pop()?.toLowerCase() ?? input.fileName.toLowerCase();
  const ext = extensionOf(input.fileName);
  const type = input.contentType?.toLowerCase() ?? '';

  if (baseName === 'skill.md') return { icon: TextIcon, kind: 'text' };
  if (configNames.has(baseName)) return { icon: Settings02Icon, kind: 'config' };
  if (input.preview === 'unsupported') return { icon: FileXIcon, kind: 'unsupported' };
  if (input.preview === 'image' || type.startsWith('image/') || imageExtensions.has(ext))
    return { icon: FileImageIcon, kind: 'image' };
  if (type.startsWith('audio/') || audioExtensions.has(ext)) return { icon: FileAudioIcon, kind: 'audio' };
  if (type.startsWith('video/') || videoExtensions.has(ext)) return { icon: FileVideoIcon, kind: 'video' };
  if (archiveExtensions.has(ext)) return { icon: FileArchiveIcon, kind: 'archive' };
  if (fontExtensions.has(ext)) return { icon: FileTypeIcon, kind: 'font' };
  if (spreadsheetExtensions.has(ext)) return { icon: FileSpreadsheetIcon, kind: 'spreadsheet' };
  if (dataExtensions.has(ext)) return { icon: DatabaseIcon, kind: 'data' };
  if (shellExtensions.has(ext)) return { icon: ComputerTerminal01Icon, kind: 'code' };
  if (ext === 'json' || ext === 'jsonc' || ext === 'jsonl') return { icon: FileBracesIcon, kind: 'code' };
  if (ext === 'yaml' || ext === 'yml' || ext === 'toml') return { icon: BracesIcon, kind: 'code' };
  if (baseName.includes('secret') || baseName.includes('credential') || baseName.includes('key'))
    return { icon: FileLockIcon, kind: 'locked' };
  if (codeExtensions.has(ext)) return { icon: FileCodeIcon, kind: 'code' };
  if (input.preview === 'text' || type.startsWith('text/') || textExtensions.has(ext))
    return { icon: TextIcon, kind: 'text' };
  if (baseName.endsWith('config')) return { icon: FileCogIcon, kind: 'config' };
  return { icon: File01Icon, kind: 'file' };
}

export function FileIcon({ className, contentType, fileName, preview }: FileIconProps) {
  const selected = fileIcon({ contentType, fileName, preview });
  return (
    <HugeiconsIcon
      aria-hidden="true"
      className={className}
      data-file-icon={selected.kind}
      icon={selected.icon}
    />
  );
}
