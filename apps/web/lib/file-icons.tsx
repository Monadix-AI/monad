'use client';

import type { LucideIcon } from 'lucide-react';

import {
  Braces,
  Database,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo,
  FileX,
  Settings,
  Terminal
} from 'lucide-react';

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

function getFileIconForName({ contentType, fileName, preview }: FileIconInput): LucideIcon {
  const baseName = fileName.split('/').pop()?.toLowerCase() ?? fileName.toLowerCase();
  const ext = extensionOf(fileName);
  const type = contentType?.toLowerCase() ?? '';

  if (baseName === 'skill.md') return FileText;
  if (configNames.has(baseName)) return Settings;
  if (preview === 'unsupported') return FileX;
  if (preview === 'image' || type.startsWith('image/') || imageExtensions.has(ext)) return FileImage;
  if (type.startsWith('audio/') || audioExtensions.has(ext)) return FileAudio;
  if (type.startsWith('video/') || videoExtensions.has(ext)) return FileVideo;
  if (archiveExtensions.has(ext)) return FileArchive;
  if (fontExtensions.has(ext)) return FileType;
  if (spreadsheetExtensions.has(ext)) return FileSpreadsheet;
  if (dataExtensions.has(ext)) return Database;
  if (shellExtensions.has(ext)) return Terminal;
  if (ext === 'json' || ext === 'jsonc' || ext === 'jsonl') return FileJson;
  if (ext === 'yaml' || ext === 'yml' || ext === 'toml') return Braces;
  if (baseName.includes('secret') || baseName.includes('credential') || baseName.includes('key')) return FileLock;
  if (codeExtensions.has(ext)) return FileCode;
  if (preview === 'text' || type.startsWith('text/') || textExtensions.has(ext)) return FileText;
  if (baseName.endsWith('config')) return FileCog;
  return File;
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
  return <Icon className={className} />;
}
