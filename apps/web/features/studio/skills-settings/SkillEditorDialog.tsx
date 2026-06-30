import type { SkillContentFile } from '@monad/protocol';
import type { BundledLanguage } from 'shiki';
import type { SkillAttachmentPreview, SkillEditorState } from './types';

import { useUpdateSkillContentMutation, useUploadSkillMutation } from '@monad/client-rtk';
import { Badge, Button, ScrollArea, Textarea } from '@monad/ui';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { CodeBlock } from '@/components/ai-elements/code-block';
import { useT } from '@/components/I18nProvider';
import { Markdown } from '@/components/Markdown';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { FileIcon } from '@/lib/file-icons';
import { useMonadRuntime } from '@/lib/monad-runtime-provider';
import { formatAttachmentSize, loadSkillContent, parseSkillFrontmatter, parseSkillPreview } from './utils';

export function SkillEditorDialog({
  editor,
  lockedPreview,
  initialView,
  onClose,
  onSaved
}: {
  editor: SkillEditorState | null;
  lockedPreview?: boolean;
  initialView?: 'edit' | 'preview';
  onClose: () => void;
  onSaved: () => void;
}) {
  if (!editor) return null;
  return (
    <SkillEditorForm
      editor={editor}
      initialView={initialView}
      key={editor.id ?? editor.name ?? 'new-skill'}
      lockedPreview={lockedPreview}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function languageForAttachment(file: SkillContentFile): BundledLanguage {
  const language = file.language;
  if (
    language === 'bash' ||
    language === 'css' ||
    language === 'html' ||
    language === 'javascript' ||
    language === 'json' ||
    language === 'jsx' ||
    language === 'markdown' ||
    language === 'python' ||
    language === 'tsx' ||
    language === 'typescript' ||
    language === 'yaml'
  ) {
    return language;
  }
  return 'text' as BundledLanguage;
}

function SkillEditorForm({
  editor,
  lockedPreview = false,
  initialView = 'edit',
  onClose,
  onSaved
}: {
  editor: SkillEditorState;
  lockedPreview?: boolean;
  initialView?: 'edit' | 'preview';
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const { client: monadClient } = useMonadRuntime();
  const [content, setContent] = useState(editor.content);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'edit' | 'preview'>(lockedPreview ? 'preview' : initialView);
  const [attachmentPreview, setAttachmentPreview] = useState<SkillAttachmentPreview | null>(null);
  const [attachmentLoading, setAttachmentLoading] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [uploadSkill, { isLoading: creating }] = useUploadSkillMutation();
  const [updateSkillContent, { isLoading: updating }] = useUpdateSkillContentMutation();
  const saving = creating || updating;
  const editorTitle = editor.title ?? editor.name;
  const files = editor.files ?? [];
  const showingAttachment = attachmentPreview !== null;

  const closeAttachmentPreview = () => {
    setAttachmentPreview(null);
    setAttachmentError(null);
    setView('edit');
  };

  const openAttachment = async (file: SkillContentFile) => {
    if (!(editor.name && editor.id)) return;
    setAttachmentError(null);
    setAttachmentLoading(file.path);
    const res = await loadSkillContent({ id: editor.id, name: editor.name }, monadClient, file.path).catch(() => null);
    if (res) {
      setAttachmentPreview({
        content: res.content,
        contentType: res.contentType,
        file,
        preview: res.preview
      });
      setView('preview');
    } else {
      setAttachmentError(t('web.skills.attachmentLoadFailed'));
    }
    setAttachmentLoading(null);
  };

  const save = async () => {
    if (!content.trim()) return;
    setError(null);
    const frontmatter = parseSkillFrontmatter(content);
    if (!frontmatter.name || !frontmatter.description) {
      setError(t('web.skills.parseMissingFields'));
      return;
    }
    if (editor.name && frontmatter.name !== editor.name) {
      setError(t('web.skills.parseNameMismatch', { name: editor.name }));
      return;
    }
    if (editor.name) {
      const res = await updateSkillContent({ name: editor.name, id: editor.id, content })
        .unwrap()
        .catch(() => null);
      if (res) {
        onSaved();
        return;
      }
    } else {
      const file = new File([content], 'SKILL.md', { type: 'text/markdown' });
      const res = await uploadSkill({ filename: file.name, body: file, contentType: file.type, overwrite: true })
        .unwrap()
        .catch(() => null);
      if (res) {
        onSaved();
        return;
      }
    }
    setError(t('web.skills.saveFailed'));
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent className="flex max-h-[86vh] max-w-3xl flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {editorTitle ? t('web.skills.editTitle', { name: editorTitle }) : t('web.skills.newTitle')}
          </DialogTitle>
          <DialogDescription>
            {lockedPreview ? t('web.skills.previewHint') : t('web.skills.editorHint')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              {showingAttachment ? (
                <Button
                  className="h-7 gap-1.5 px-2 text-xs"
                  onClick={closeAttachmentPreview}
                  size="sm"
                  variant="ghost"
                >
                  <ArrowLeft className="size-3.5" />
                  SKILL.md
                </Button>
              ) : (
                <>
                  <FileIcon
                    className="size-4 shrink-0 text-muted-foreground"
                    fileName="SKILL.md"
                    preview="text"
                  />
                  <span className="truncate font-mono text-xs">SKILL.md</span>
                </>
              )}
              {attachmentPreview ? (
                <span className="min-w-0 truncate font-mono text-muted-foreground text-xs">
                  / {attachmentPreview.file.path}
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                className="h-7 px-2 text-xs"
                disabled={lockedPreview || showingAttachment}
                onClick={() => {
                  setAttachmentPreview(null);
                  setView('edit');
                }}
                size="sm"
                variant={!showingAttachment && view === 'edit' ? 'secondary' : 'ghost'}
              >
                {t('web.skills.editorEdit')}
              </Button>
              <Button
                className="h-7 px-2 text-xs"
                disabled={showingAttachment}
                onClick={() => {
                  setAttachmentPreview(null);
                  setView('preview');
                }}
                size="sm"
                variant={!showingAttachment && view === 'preview' ? 'secondary' : 'ghost'}
              >
                {t('web.skills.editorPreview')}
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
            {attachmentPreview ? (
              attachmentPreview.preview === 'text' ? (
                <CodeBlock
                  className="h-[44vh] min-h-[280px] [&>div]:h-[44vh] [&>div]:min-h-[280px]"
                  code={attachmentPreview.content}
                  language={languageForAttachment(attachmentPreview.file)}
                  showLineNumbers
                />
              ) : attachmentPreview.preview === 'image' ? (
                <div className="grid min-h-0 flex-1 place-items-center overflow-hidden bg-muted/20 p-4">
                  {/* biome-ignore lint/performance/noImgElement: Skill previews render local data URLs, not network images. */}
                  <img
                    alt={attachmentPreview.file.path}
                    className="h-full max-h-full w-full max-w-full rounded border bg-background object-contain"
                    src={`data:${attachmentPreview.contentType ?? 'image/*'};base64,${attachmentPreview.content}`}
                  />
                </div>
              ) : (
                <div className="flex h-[44vh] min-h-[280px] flex-col items-center justify-center gap-2 bg-muted/20 p-4 text-center">
                  <FileIcon
                    className="size-7 text-muted-foreground"
                    contentType={attachmentPreview.contentType}
                    fileName={attachmentPreview.file.path}
                    preview={attachmentPreview.preview}
                  />
                  <p className="font-medium text-sm">{t('web.skills.previewUnsupported')}</p>
                  <p className="max-w-sm text-muted-foreground text-xs">
                    {t('web.skills.previewUnsupportedHint', {
                      type: attachmentPreview.contentType ?? t('web.skills.previewUnknownType')
                    })}
                  </p>
                </div>
              )
            ) : view === 'edit' ? (
              <Textarea
                className="h-[44vh] min-h-[280px] resize-none overflow-auto border-0 font-mono text-xs shadow-none focus-visible:ring-0"
                onChange={(event) => setContent(event.target.value)}
                spellCheck={false}
                value={content}
              />
            ) : (
              <SkillPreview content={content} />
            )}
          </div>
          {files.length > 0 ? (
            <section className="flex max-h-[22vh] min-h-28 min-w-0 flex-col gap-2 overflow-hidden rounded-md border border-dashed bg-muted/10 p-3">
              <div className="flex items-center gap-2">
                <span className="font-medium text-xs">{t('web.skills.attachments')}</span>
                <Badge
                  className="h-5 px-1.5 text-[10px]"
                  variant="secondary"
                >
                  {files.length}
                </Badge>
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(min(100%,10rem),1fr))] content-start gap-1.5 overflow-y-auto pr-1">
                {files.map((file) => {
                  const fileName = file.path.split('/').pop() ?? file.path;
                  return (
                    <Button
                      className="h-8 min-w-0 justify-start gap-2 overflow-hidden px-2 text-left"
                      disabled={attachmentLoading === file.path}
                      key={file.path}
                      onClick={() => void openAttachment(file)}
                      variant={attachmentPreview?.file.path === file.path ? 'secondary' : 'ghost'}
                    >
                      {attachmentLoading === file.path ? (
                        <Loader2 className="size-3.5 shrink-0 animate-spin text-foreground" />
                      ) : (
                        <FileIcon
                          className="size-3.5 shrink-0 text-muted-foreground"
                          contentType={file.contentType}
                          fileName={file.path}
                          preview={file.preview}
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{fileName}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {formatAttachmentSize(file.size)}
                      </span>
                    </Button>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>
        {attachmentError ? <p className="text-destructive text-xs">{attachmentError}</p> : null}
        {error ? <p className="text-destructive text-xs">{error}</p> : null}
        <DialogFooter>
          <Button
            onClick={onClose}
            variant="outline"
          >
            {t('web.cancel')}
          </Button>
          {!lockedPreview ? (
            <Button
              disabled={saving || !content.trim()}
              onClick={() => void save()}
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t('web.save')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SkillPreview({ content }: { content: string }) {
  const t = useT();
  const { metadata, body } = useMemo(() => parseSkillPreview(content), [content]);
  return (
    <ScrollArea className="h-[44vh] min-h-[280px]">
      <div className="flex flex-col gap-4 p-4">
        {metadata.length > 0 ? (
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('web.skills.previewMetadata')}</caption>
              <tbody>
                {metadata.map(([key, value]) => (
                  <tr
                    className="border-b last:border-b-0"
                    key={key}
                  >
                    <th className="w-40 bg-muted/40 px-3 py-2 text-left align-top font-medium text-muted-foreground">
                      {key}
                    </th>
                    <td className="break-words px-3 py-2">{value || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <Markdown
          className="max-w-[72ch]"
          text={(body || content || t('web.skills.previewEmpty')).trim()}
          variant="compact"
        />
      </div>
    </ScrollArea>
  );
}
