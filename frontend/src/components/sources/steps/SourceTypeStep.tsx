"use client"

import { useMemo, useState } from "react"
import { Control, FieldErrors, UseFormRegister, UseFormSetValue, useWatch } from "react-hook-form"
import {
  FileIcon,
  LinkIcon,
  FileTextIcon,
  FolderGit2,
  Loader2,
  ChevronDown,
  ChevronRight,
  GitBranch,
  CheckCircle2,
  AlertCircle,
  Sparkles,
} from "lucide-react"
import { useTranslation } from "@/lib/hooks/use-translation"
import { FormSection } from "@/components/ui/form-section"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Controller } from "react-hook-form"
import { sourcesApi } from "@/lib/api/sources"
import { GitHubPreviewResponse } from "@/lib/types/api"

interface CreateSourceFormData {
  type: 'link' | 'upload' | 'text' | 'github'
  title?: string
  url?: string
  content?: string
  file?: FileList | File
  github_subdir?: string
  github_include_ext?: string
  github_token?: string
  notebooks?: string[]
  transformations?: string[]
  embed: boolean
  async_processing: boolean
}

export function looksLikeGitHubRepoUrl(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.includes('\n')) return false
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) return true
  try {
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    const host = u.hostname.toLowerCase()
    if (host !== 'github.com' && host !== 'www.github.com') return false
    const parts = u.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return false
    if (parts.length === 2) return true
    const section = parts[2].toLowerCase()
    return section === 'tree' || section === 'blob'
  } catch {
    return false
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

// Helper functions for batch URL parsing
function parseUrls(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

function validateUrl(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

export function parseAndValidateUrls(text: string): {
  valid: string[]
  invalid: { url: string; line: number }[]
} {
  const lines = text.split('\n')
  const valid: string[] = []
  const invalid: { url: string; line: number }[] = []

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return // skip empty lines

    if (validateUrl(trimmed)) {
      valid.push(trimmed)
    } else {
      invalid.push({ url: trimmed, line: index + 1 })
    }
  })

  return { valid, invalid }
}

import type { TFunction } from 'i18next'

const getSourceTypes = (t: TFunction) => [
  {
    value: 'link' as const,
    label: t('sources.addUrl'),
    icon: LinkIcon,
    description: t('sources.processDescription'),
  },
  {
    value: 'github' as const,
    label: 'GitHub',
    icon: FolderGit2,
    description:
      'Import a GitHub repository or directory as a single source with an AI-generated overview, directory tree, main files guide, and vector-indexed code.',
  },
  {
    value: 'upload' as const,
    label: t('sources.uploadFile'),
    icon: FileIcon,
    description: t('sources.processDescription'),
  },
  {
    value: 'text' as const,
    label: t('sources.enterText'),
    icon: FileTextIcon,
    description: t('sources.processDescription'),
  },
]

interface SourceTypeStepProps {
  control: Control<CreateSourceFormData>
  register: UseFormRegister<CreateSourceFormData>
  setValue: UseFormSetValue<CreateSourceFormData>
  errors: FieldErrors<CreateSourceFormData>
  urlValidationErrors?: { url: string; line: number }[]
  onClearUrlErrors?: () => void
}

const MAX_BATCH_SIZE = 50

export function SourceTypeStep({ control, register, setValue, errors, urlValidationErrors, onClearUrlErrors }: SourceTypeStepProps) {
  const { t } = useTranslation()
  // Watch the selected type and inputs to detect batch mode
  const selectedType = useWatch({ control, name: 'type' })
  const urlInput = useWatch({ control, name: 'url' })
  const fileInput = useWatch({ control, name: 'file' })
  const githubSubdir = useWatch({ control, name: 'github_subdir' })
  const githubIncludeExt = useWatch({ control, name: 'github_include_ext' })
  const githubToken = useWatch({ control, name: 'github_token' })

  // Track if HTML content was pasted
  const [hasHtmlContent, setHasHtmlContent] = useState(false)

  // GitHub preview state
  const [showGithubAdvanced, setShowGithubAdvanced] = useState(false)
  const [githubPreview, setGithubPreview] = useState<GitHubPreviewResponse | null>(null)
  const [githubPreviewLoading, setGithubPreviewLoading] = useState(false)
  const [githubPreviewError, setGithubPreviewError] = useState<string | null>(null)

  const handlePreviewGitHub = async () => {
    const trimmed = (urlInput || '').trim()
    if (!trimmed) return
    setGithubPreviewLoading(true)
    setGithubPreviewError(null)
    try {
      const result = await sourcesApi.previewGitHub({
        url: trimmed,
        subdir: githubSubdir?.trim() || undefined,
        include_ext: githubIncludeExt?.trim() || undefined,
        token: githubToken?.trim() || undefined,
      })
      setGithubPreview(result)
    } catch (err: unknown) {
      setGithubPreview(null)
      const detail =
        (err as { response?: { data?: { detail?: string } }; message?: string })?.response?.data?.detail ||
        (err as { message?: string })?.message ||
        'Could not preview repository.'
      setGithubPreviewError(detail)
    } finally {
      setGithubPreviewLoading(false)
    }
  }

  const singleLinkLooksLikeGithub = useMemo(() => {
    if (selectedType !== 'link' || !urlInput) return false
    const urls = parseUrls(urlInput)
    return urls.length === 1 && looksLikeGitHubRepoUrl(urls[0])
  }, [selectedType, urlInput])

  // Handle paste event to check for HTML content in clipboard
  const handleTextPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const htmlContent = event.clipboardData.getData('text/html')

    // If HTML content is available, use it instead of plain text
    if (htmlContent) {
      event.preventDefault()
      // Get current content and cursor position
      const textarea = event.currentTarget
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const currentValue = textarea.value

      // Insert HTML content at cursor position (replacing selection if any)
      const newValue = currentValue.substring(0, start) + htmlContent + currentValue.substring(end)
      setValue('content', newValue, { shouldValidate: true })
      setHasHtmlContent(true)
    } else {
      // Plain text paste - clear the HTML indicator
      setHasHtmlContent(false)
    }
  }

  // Batch mode detection
  const { isBatchMode, itemCount, urlCount, fileCount } = useMemo(() => {
    let urlCount = 0
    let fileCount = 0

    if (selectedType === 'link' && urlInput) {
      const urls = parseUrls(urlInput)
      urlCount = urls.length
    }

    if (selectedType === 'upload' && fileInput) {
      const fileList = fileInput as FileList
      fileCount = fileList?.length || 0
    }

    const isBatchMode = urlCount > 1 || fileCount > 1
    const itemCount = selectedType === 'link' ? urlCount : fileCount

    return { isBatchMode, itemCount, urlCount, fileCount }
  }, [selectedType, urlInput, fileInput])

  // Check for batch size limit
  const isOverLimit = itemCount > MAX_BATCH_SIZE
  return (
    <div className="space-y-6">
      <FormSection
        title={t('sources.title')}
        description={t('sources.processDescription')}
      >
        <Controller
          control={control}
          name="type"
          render={({ field }) => (
            <Tabs 
              value={field.value || ''} 
              onValueChange={(value) => {
                field.onChange(value as 'link' | 'upload' | 'text' | 'github')
                setGithubPreview(null)
                setGithubPreviewError(null)
              }}
              className="w-full"
            >
              <TabsList className="grid w-full grid-cols-4">
                {getSourceTypes(t).map((type) => {
                  const Icon = type.icon
                  return (
                    <TabsTrigger key={type.value} value={type.value} className="gap-1.5 px-2 text-xs sm:text-sm">
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{type.label}</span>
                    </TabsTrigger>
                  )
                })}
              </TabsList>
              
              {getSourceTypes(t).map((type) => (
                <TabsContent key={type.value} value={type.value} className="mt-4">
                  <p className="text-sm text-muted-foreground mb-4">{type.description}</p>
                  
                  {/* Type-specific fields */}
                  {type.value === 'link' && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <Label htmlFor="url">{t('sources.urlLabel')}</Label>
                        {urlCount > 0 && (
                          <Badge variant={isOverLimit ? "destructive" : "secondary"}>
                            {t('sources.urlsCount', { count: urlCount })}
                            {isOverLimit && ` (${t('sources.maxItems', { count: MAX_BATCH_SIZE })})`}
                          </Badge>
                        )}
                      </div>
                      <Textarea
                        id="url"
                        {...register('url', {
                          onChange: () => onClearUrlErrors?.()
                        })}
                        placeholder={t('sources.enterUrlsPlaceholder')}
                        rows={urlCount > 1 ? 6 : 2}
                        className="font-mono text-sm"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {t('sources.batchUrlHint')}
                      </p>
                      {singleLinkLooksLikeGithub && (
                        <div className="mt-2.5 flex items-center justify-between gap-3 rounded-md border border-purple-500/30 bg-purple-500/10 px-3 py-2">
                          <div className="flex items-center gap-2 text-xs text-foreground">
                            <FolderGit2 className="h-4 w-4 text-purple-400 shrink-0" />
                            <span>
                              GitHub repository detected. Use the <strong>GitHub</strong> tab to import the full codebase, directory tree, and summary.
                            </span>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="h-7 shrink-0 text-xs"
                            onClick={() => {
                              setValue('type', 'github', { shouldValidate: true })
                              onClearUrlErrors?.()
                            }}
                          >
                            Switch to GitHub
                          </Button>
                        </div>
                      )}
                      {errors.url && (
                        <p className="text-sm text-destructive mt-1">{errors.url.message}</p>
                      )}
                      {urlValidationErrors && urlValidationErrors.length > 0 && (
                        <div className="mt-2 p-3 bg-destructive/10 rounded-md border border-destructive/20">
                          <p className="text-sm font-medium text-destructive mb-2">
                            {t('sources.invalidUrlsDetected')}
                          </p>
                          <ul className="space-y-1">
                            {urlValidationErrors.map((error, idx) => (
                              <li key={idx} className="text-xs text-destructive flex items-start gap-2">
                                <span className="font-mono bg-destructive/20 px-1 rounded">
                                  {t('sources.lineLabel', { line: error.line.toString() })}
                                </span>
                                <span className="truncate">{error.url}</span>
                              </li>
                            ))}
                          </ul>
                          <p className="text-xs text-muted-foreground mt-2">
                            {t('sources.fixInvalidUrls')}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                  
                  {type.value === 'github' && (
                    <div className="space-y-3">
                      <div>
                        <Label htmlFor="github-url" className="mb-2 block">
                          Repository or Directory URL
                        </Label>
                        <div className="flex gap-2">
                          <Input
                            id="github-url"
                            {...register('url', {
                              onChange: () => {
                                onClearUrlErrors?.()
                                setGithubPreview(null)
                                setGithubPreviewError(null)
                              },
                            })}
                            placeholder="https://github.com/owner/repo  or  .../tree/main/src"
                            className="font-mono text-sm"
                            autoComplete="off"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            onClick={handlePreviewGitHub}
                            disabled={githubPreviewLoading || !(urlInput || '').trim()}
                            className="shrink-0"
                          >
                            {githubPreviewLoading ? (
                              <>
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                Checking...
                              </>
                            ) : (
                              'Preview'
                            )}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          Supports full repositories, specific branches/subfolders (<code>/tree/branch/dir</code>), or shorthand like <code>owner/repo</code>. Binaries, lockfiles, and build folders are skipped automatically.
                        </p>
                        {errors.url && (
                          <p className="text-sm text-destructive mt-1">{errors.url.message}</p>
                        )}
                      </div>

                      {githubPreviewError && (
                        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                          <span>{githubPreviewError}</span>
                        </div>
                      )}

                      {githubPreview && (
                        <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-3.5 space-y-2.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                              <span className="font-mono text-sm font-medium truncate">
                                {githubPreview.full_name}
                                {githubPreview.subdir ? `/${githubPreview.subdir}` : ''}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <Badge variant="secondary" className="gap-1 font-mono text-[11px]">
                                <GitBranch className="h-3 w-3" />
                                {githubPreview.branch}
                              </Badge>
                              {githubPreview.primary_language && (
                                <Badge variant="outline" className="text-[11px]">
                                  {githubPreview.primary_language}
                                </Badge>
                              )}
                            </div>
                          </div>

                          {githubPreview.description && (
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              {githubPreview.description}
                            </p>
                          )}

                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            <span>
                              <strong className="text-foreground">{githubPreview.included_files}</strong> files to index
                            </span>
                            {githubPreview.skipped_files > 0 && (
                              <span>{githubPreview.skipped_files} skipped (binaries/lockfiles)</span>
                            )}
                            <span>~{formatBytes(githubPreview.estimated_bytes)} text</span>
                            {githubPreview.license && <span>{githubPreview.license}</span>}
                          </div>

                          {Object.keys(githubPreview.top_languages).length > 0 && (
                            <div className="flex flex-wrap gap-1.5 pt-0.5">
                              {Object.entries(githubPreview.top_languages).map(([ext, count]) => (
                                <span
                                  key={ext}
                                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                                >
                                  {ext} ({count})
                                </span>
                              ))}
                            </div>
                          )}

                          {githubPreview.truncated && (
                            <p className="text-[11px] text-amber-400 flex items-center gap-1.5">
                              <Sparkles className="h-3.5 w-3.5 shrink-0" />
                              Large repo — top 250 prioritized files will be indexed. Set a subfolder below to focus on a specific area.
                            </p>
                          )}
                        </div>
                      )}

                      <div className="rounded-md border border-border/70">
                        <button
                          type="button"
                          onClick={() => setShowGithubAdvanced((prev) => !prev)}
                          className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <span>Advanced options (subfolder, extensions, private repo token)</span>
                          {showGithubAdvanced ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                        </button>
                        {showGithubAdvanced && (
                          <div className="border-t border-border/70 p-3 space-y-3">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <div>
                                <Label htmlFor="github-subdir" className="text-xs mb-1 block">
                                  Subfolder filter (optional)
                                </Label>
                                <Input
                                  id="github-subdir"
                                  {...register('github_subdir')}
                                  placeholder="e.g. src/api or docs"
                                  className="h-8 font-mono text-xs"
                                  autoComplete="off"
                                />
                              </div>
                              <div>
                                <Label htmlFor="github-ext" className="text-xs mb-1 block">
                                  Only include extensions (optional)
                                </Label>
                                <Input
                                  id="github-ext"
                                  {...register('github_include_ext')}
                                  placeholder="e.g. .py, .ts, .md"
                                  className="h-8 font-mono text-xs"
                                  autoComplete="off"
                                />
                              </div>
                            </div>
                            <div>
                              <Label htmlFor="github-token" className="text-xs mb-1 block">
                                GitHub Access Token (optional, for private repos — never stored)
                              </Label>
                              <Input
                                id="github-token"
                                type="password"
                                {...register('github_token')}
                                placeholder="ghp_... or github_pat_..."
                                className="h-8 font-mono text-xs"
                                autoComplete="off"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {type.value === 'upload' && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <Label htmlFor="file">{t('sources.fileLabel')}</Label>
                        {fileCount > 0 && (
                          <Badge variant={isOverLimit ? "destructive" : "secondary"}>
                            {t('sources.filesCount', { count: fileCount })}
                            {isOverLimit && ` (${t('sources.maxItems', { count: MAX_BATCH_SIZE })})`}
                          </Badge>
                        )}
                      </div>
                      <div className="relative">
                        <input
                          id="file"
                          type="file"
                          multiple
                          {...register('file')}
                          accept=".pdf,.doc,.docx,.pptx,.ppt,.xlsx,.xls,.odt,.ods,.odp,.txt,.md,.epub,.mp4,.avi,.mov,.wmv,.mp3,.wav,.m4a,.aac,.jpg,.jpeg,.png,.tiff,.html,.htm"
                          className="peer sr-only"
                        />
                        <label
                          htmlFor="file"
                          className="flex h-10 w-full cursor-pointer items-center rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-colors hover:bg-accent/40 peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2"
                        >
                          {fileCount === 1 && fileInput instanceof FileList ? (
                            <span className="truncate text-foreground">{fileInput[0].name}</span>
                          ) : fileCount > 1 ? (
                            <span className="truncate text-foreground">
                              {t('sources.filesCount', { count: fileCount })}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">Choose file(s)...</span>
                          )}
                        </label>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {t('sources.selectMultipleFilesHint')}
                      </p>
                      {fileCount > 1 && fileInput instanceof FileList && (
                        <div className="mt-2 p-3 rounded-md border border-border">
                          <p className="text-xs font-medium mb-2">{t('sources.selectedFiles')}</p>
                          <ul className="space-y-1 max-h-32 overflow-y-auto">
                            {Array.from(fileInput).map((file, idx) => (
                              <li key={idx} className="text-xs text-muted-foreground flex items-center gap-2">
                                <FileIcon className="h-3 w-3" />
                                <span className="truncate">{file.name}</span>
                                <span className="text-muted-foreground/50">
                                  ({(file.size / 1024).toFixed(1)} KB)
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {errors.file && (
                        <p className="text-sm text-destructive mt-1">{errors.file.message}</p>
                      )}
                      {isOverLimit && selectedType === 'upload' && (
                        <p className="text-sm text-destructive mt-1">
                          {t('sources.maxFilesAllowed', { count: MAX_BATCH_SIZE })}
                        </p>
                      )}
                    </div>
                  )}
                  
                  {type.value === 'text' && (
                    <div>
                      <Label htmlFor="content" className="mb-2 block">{t('sources.textContentLabel')}</Label>
                      {hasHtmlContent && (
                        <p className="mb-2 flex items-center gap-2 text-sm text-teal">
                          <span className="h-1.5 w-1.5 rounded-full bg-teal" aria-hidden="true" />
                          {t('sources.htmlDetected')}
                        </p>
                      )}
                      <Textarea
                        id="content"
                        {...register('content')}
                        placeholder={t('sources.textPlaceholder')}
                        rows={6}
                        onPaste={handleTextPaste}
                      />
                      {errors.content && (
                        <p className="text-sm text-destructive mt-1">{errors.content.message}</p>
                      )}
                    </div>
                  )}
                </TabsContent>
              ))}
            </Tabs>
          )}
        />
        {errors.type && (
          <p className="text-sm text-destructive mt-1">{errors.type.message}</p>
        )}
      </FormSection>

      {/* Hide title field in batch mode - titles will be auto-generated */}
      {!isBatchMode && (
        <FormSection
          htmlFor="source-title"
          title={selectedType === 'text' ? `${t('common.title')} *` : `${t('common.title')} (${t('common.optional')})`}
          description={selectedType === 'text'
            ? t('sources.titleRequired')
            : t('sources.titleGenerated')
          }
        >
          <Input
            id="source-title"
            {...register('title')}
            placeholder={t('sources.titlePlaceholder')}
            autoComplete="off"
          />
          {errors.title && (
            <p className="text-sm text-destructive mt-1">{errors.title.message}</p>
          )}
        </FormSection>
      )}

      {/* Batch mode indicator */}
      {isBatchMode && (
        <div className="p-4 rounded-md border border-border">
          <div className="flex items-center gap-2 mb-2">
            <Badge variant="default">{t('common.batchMode')}</Badge>
            <span className="text-sm font-medium">
              {t('sources.batchCount', { count: itemCount, type: selectedType === 'link' ? t('sources.addUrl') : t('sources.uploadFile') })}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('sources.batchTitlesAuto')}
            {t('sources.batchCommonSettings')}
          </p>
        </div>
      )}
    </div>
  )
}
