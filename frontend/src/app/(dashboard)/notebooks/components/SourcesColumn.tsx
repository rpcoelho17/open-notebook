'use client'

import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { SourceListResponse } from '@/lib/types/api'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Plus,
  FileText,
  FolderGit2,
  Globe,
  Link2,
  Loader2,
  MoreVertical,
  Trash2,
  Unlink,
  RefreshCw,
  PanelLeftClose,
  PanelLeftOpen,
  Check,
  AlertCircle,
  AlignLeft,
  Download,
  Search,
  X,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import apiClient from '@/lib/api/client'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { AddSourceDialog } from '@/components/sources/AddSourceDialog'
import { AddExistingSourceDialog } from '@/components/sources/AddExistingSourceDialog'
import { NoteEditorDialog } from './NoteEditorDialog'
import {
  useDeleteSource,
  useRetrySource,
  useRemoveSourceFromNotebook,
} from '@/lib/hooks/use-sources'
import { useModels } from '@/lib/hooks/use-models'
import { useSettings, useUpdateSettings } from '@/lib/hooks/use-settings'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useModalManager } from '@/lib/hooks/use-modal-manager'
import { ContextMode } from '../[id]/page'
import type { SourceBulkAction } from '@/lib/utils/source-context'
import { useNotebookColumnsStore } from '@/lib/stores/notebook-columns-store'
import { useTranslation } from '@/lib/hooks/use-translation'

interface SourcesColumnProps {
  sources?: SourceListResponse[]
  isLoading: boolean
  notebookId: string
  notebookName?: string
  onRefresh?: () => void
  contextSelections?: Record<string, ContextMode>
  onContextModeChange?: (sourceId: string, mode: ContextMode) => void
  onBulkContextModeChange?: (action: SourceBulkAction) => void
  hasNextPage?: boolean
  isFetchingNextPage?: boolean
  fetchNextPage?: () => void
}

function getSourceIcon(source: SourceListResponse) {
  const status = source.status
  if (status === 'running' || status === 'queued' || status === 'new') {
    return <Loader2 className="h-4 w-4 text-[#8ab4f8] animate-spin shrink-0" />
  }
  if (status === 'failed') {
    return <AlertCircle className="h-4 w-4 text-red-400 shrink-0" />
  }
  if (source.asset?.url) {
    if (/^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+/i.test(source.asset.url)) {
      return <FolderGit2 className="h-4 w-4 text-purple-400 shrink-0" />
    }
    return <Globe className="h-4 w-4 text-[#f97316] shrink-0" />
  }
  if (source.asset?.file_path) {
    return <FileText className="h-4 w-4 text-[#60a5fa] shrink-0" />
  }
  return <AlignLeft className="h-4 w-4 text-emerald-400 shrink-0" />
}

interface SaveFilePickerWritable {
  write: (data: string | Blob) => Promise<void>
  close: () => Promise<void>
}

interface SaveFilePickerHandle {
  name: string
  createWritable: () => Promise<SaveFilePickerWritable>
}

interface SaveFilePickerOptions {
  suggestedName?: string
  types?: Array<{
    description?: string
    accept: Record<string, string[]>
  }>
}

function sanitizeBaseFilename(name?: string): string {
  const cleaned = (name || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  return cleaned || 'notebook-sources'
}

export function SourcesColumn({
  sources,
  isLoading,
  notebookId,
  notebookName,
  onRefresh,
  contextSelections,
  onContextModeChange,
  onBulkContextModeChange,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: SourcesColumnProps) {
  const { t } = useTranslation()
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [addExistingDialogOpen, setAddExistingDialogOpen] = useState(false)
  const [noteEditorOpen, setNoteEditorOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [sourceToDelete, setSourceToDelete] = useState<string | null>(null)
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false)
  const [sourceToRemove, setSourceToRemove] = useState<string | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [exportFilenameDraft, setExportFilenameDraft] = useState('')
  const [exportAndClean, setExportAndClean] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  const { openModal } = useModalManager()
  const deleteSource = useDeleteSource()
  const retrySource = useRetrySource()
  const removeFromNotebook = useRemoveSourceFromNotebook()
  const { data: allModels = [] } = useModels()
  const languageModels = useMemo(
    () => allModels.filter((m) => m.type === 'language'),
    [allModels]
  )
  const { data: appSettings } = useSettings()
  const updateAppSettings = useUpdateSettings()
  const { sourcesCollapsed, toggleSources } = useNotebookColumnsStore()

  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container || !hasNextPage || isFetchingNextPage || !fetchNextPage) return
    const { scrollTop, scrollHeight, clientHeight } = container
    if (scrollHeight - scrollTop - clientHeight < 200) {
      fetchNextPage()
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    container.addEventListener('scroll', handleScroll)
    return () => container.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  // Auto-poll while any source is still extracting/embedding so the spinner clears automatically
  const hasProcessingSources = useMemo(
    () =>
      (sources ?? []).some(
        (s) => s.status === 'running' || s.status === 'queued' || s.status === 'new'
      ),
    [sources]
  )

  useEffect(() => {
    if (!hasProcessingSources || !onRefresh) return
    const timer = window.setInterval(() => {
      onRefresh()
    }, 2500)
    return () => window.clearInterval(timer)
  }, [hasProcessingSources, onRefresh])

  const handleDeleteConfirm = async () => {
    if (!sourceToDelete) return
    try {
      await deleteSource.mutateAsync(sourceToDelete)
      setDeleteDialogOpen(false)
      setSourceToDelete(null)
      onRefresh?.()
    } catch (error) {
      console.error('Failed to delete source:', error)
    }
  }

  const handleRemoveConfirm = async () => {
    if (!sourceToRemove) return
    try {
      await removeFromNotebook.mutateAsync({
        notebookId,
        sourceId: sourceToRemove,
      })
      setRemoveDialogOpen(false)
      setSourceToRemove(null)
    } catch (error) {
      console.error('Failed to remove source from notebook:', error)
    }
  }

  const handleRetry = async (sourceId: string) => {
    try {
      await retrySource.mutateAsync(sourceId)
    } catch (error) {
      console.error('Failed to retry source:', error)
    }
  }

  const totalSources = sources?.length ?? 0
  const normalizedSearch = searchQuery.trim().toLowerCase()
  const filteredSources = useMemo(() => {
    const list = sources ?? []
    if (!normalizedSearch) return list
    return list.filter((s) => {
      const title = (s.title || '').toLowerCase()
      const url = (s.asset?.url || '').toLowerCase()
      const filePath = (s.asset?.file_path || '').toLowerCase()
      return (
        title.includes(normalizedSearch) ||
        url.includes(normalizedSearch) ||
        filePath.includes(normalizedSearch)
      )
    })
  }, [sources, normalizedSearch])

  useEffect(() => {
    if (searchOpen) {
      window.requestAnimationFrame(() => searchInputRef.current?.focus())
    }
  }, [searchOpen])

  const handleToggleSearch = () => {
    setSearchOpen((prev) => {
      if (prev) setSearchQuery('')
      return !prev
    })
  }

  const selectedCount = (sources ?? []).filter(
    (s) => (contextSelections?.[s.id] ?? 'off') !== 'off'
  ).length
  const allSelected = totalSources > 0 && selectedCount === totalSources

  const handleToggleAll = () => {
    if (!onBulkContextModeChange) return
    onBulkContextModeChange(allSelected ? 'exclude' : 'full')
  }

  const handleToggleSource = (sourceId: string) => {
    if (!onContextModeChange) return
    const current = contextSelections?.[sourceId] ?? 'off'
    onContextModeChange(sourceId, current === 'off' ? 'full' : 'off')
  }

  const getExcludedSourceIds = (): string[] | undefined => {
    if (!sources || sources.length === 0) return undefined
    // If the user explicitly unchecked some sources (while keeping others checked),
    // respect that exclusion; if all or none are checked, export the whole notebook.
    if (selectedCount === 0 || selectedCount === totalSources) return undefined
    const excluded = sources
      .filter((s) => (contextSelections?.[s.id] ?? 'off') === 'off')
      .map((s) => s.id)
    return excluded.length > 0 ? excluded : undefined
  }

  const runExportRequest = async (chosenName: string, clean: boolean) => {
    const trimmedName = chosenName.trim() || `${sanitizeBaseFilename(notebookName)}.md`
    const format: 'md' | 'txt' = trimmedName.toLowerCase().endsWith('.txt') ? 'txt' : 'md'
    const normalizedName = /\.(md|txt)$/i.test(trimmedName)
      ? trimmedName
      : `${trimmedName}.${format}`

    const res = await apiClient.post<{
      filename: string
      format: 'md' | 'txt'
      source_count: number
      char_count: number
      original_char_count: number
      llm_cleaned_count: number
      cleaning_model?: string | null
      cleaned: boolean
      content: string
    }>(
      '/sources/export',
      {
        notebook_id: notebookId,
        format,
        filename: normalizedName,
        excluded_source_ids: getExcludedSourceIds(),
        clean,
      },
      { timeout: 600_000 }
    )
    return { ...res.data, normalizedName, format }
  }

  const formatExportSuccessMessage = (
    data: {
      source_count: number
      char_count: number
      original_char_count: number
      cleaning_model?: string | null
      cleaned: boolean
    },
    savedName: string
  ) => {
    const noun = data.source_count === 1 ? 'source' : 'sources'
    const modelNote = data.cleaning_model ? ` via ${data.cleaning_model}` : ''
    if (data.cleaned && data.original_char_count > 0 && data.char_count < data.original_char_count) {
      const savedPct = Math.max(
        1,
        Math.round(((data.original_char_count - data.char_count) / data.original_char_count) * 100)
      )
      return `Exported & cleaned ${data.source_count} ${noun} to ${savedName} (${savedPct}% leaner${modelNote})`
    }
    return `${data.cleaned ? 'Exported & cleaned' : 'Exported'} ${data.source_count} ${noun} to ${savedName}${modelNote}`
  }

  const handleExportSources = () => {
    if (isExporting || totalSources === 0) return
    const baseName = sanitizeBaseFilename(notebookName)
    setExportFilenameDraft(`${baseName}.md`)
    setExportDialogOpen(true)
  }

  const handleConfirmExport = async () => {
    if (isExporting) return
    const baseName = sanitizeBaseFilename(notebookName)
    const draftName = exportFilenameDraft.trim() || `${baseName}.md`
    const draftFormat: 'md' | 'txt' = draftName.toLowerCase().endsWith('.txt') ? 'txt' : 'md'
    const suggestedName = /\.(md|txt)$/i.test(draftName) ? draftName : `${draftName}.${draftFormat}`

    const win = window as unknown as {
      showSaveFilePicker?: (opts?: SaveFilePickerOptions) => Promise<SaveFilePickerHandle>
    }

    if (typeof win.showSaveFilePicker === 'function') {
      let fileHandle: SaveFilePickerHandle
      try {
        const mdType = {
          description: 'Markdown Document (.md) — RAG-Optimized',
          accept: { 'text/markdown': ['.md'] },
        }
        const txtType = {
          description: 'Plain Text Document (.txt)',
          accept: { 'text/plain': ['.txt'] },
        }
        // Must be called directly inside the click gesture before any async fetch
        fileHandle = await win.showSaveFilePicker({
          suggestedName,
          types: draftFormat === 'txt' ? [txtType, mdType] : [mdType, txtType],
        })
      } catch (err: unknown) {
        if ((err as { name?: string })?.name === 'AbortError') {
          return
        }
        console.error('Save file picker error:', err)
        toast.error('Could not open file save picker')
        return
      }

      setIsExporting(true)
      try {
        const chosenName = fileHandle.name || suggestedName
        const data = await runExportRequest(chosenName, exportAndClean)
        const writable = await fileHandle.createWritable()
        await writable.write(data.content)
        await writable.close()
        setExportDialogOpen(false)
        toast.success(formatExportSuccessMessage(data, chosenName))
      } catch (err: unknown) {
        console.error('Failed to export sources:', err)
        const detail =
          (err as { response?: { data?: { detail?: string } }; message?: string })?.response?.data
            ?.detail ||
          (err as { message?: string })?.message ||
          'Failed to export sources'
        toast.error(detail)
      } finally {
        setIsExporting(false)
      }
      return
    }

    // Fallback browser download when showSaveFilePicker is unavailable
    setIsExporting(true)
    try {
      const data = await runExportRequest(suggestedName, exportAndClean)
      const mimeType =
        data.format === 'txt' ? 'text/plain;charset=utf-8' : 'text/markdown;charset=utf-8'
      const blob = new Blob([data.content], { type: mimeType })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = data.normalizedName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setExportDialogOpen(false)
      toast.success(formatExportSuccessMessage(data, data.normalizedName))
    } catch (err: unknown) {
      console.error('Failed to export sources:', err)
      toast.error('Failed to export sources')
    } finally {
      setIsExporting(false)
    }
  }

  const exportDialog = (
    <Dialog
      open={exportDialogOpen}
      onOpenChange={(open) => {
        if (!isExporting) setExportDialogOpen(open)
      }}
    >
      <DialogContent className="sm:max-w-[460px] bg-[#1c1d20] border-[#2f3136] text-[#e8eaed]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Export Sources for RAG</DialogTitle>
          <DialogDescription className="text-xs text-[#9aa0a6]">
            Combine{' '}
            {selectedCount > 0 && selectedCount < totalSources
              ? `${selectedCount} selected`
              : `all ${totalSources}`}{' '}
            sources into a single LLM-ready document. You can also adjust the extension in the save
            picker.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3.5 py-2">
          <div className="space-y-1.5">
            <label htmlFor="export-sources-filename" className="text-xs text-[#c4c7c5]">
              File name
            </label>
            <input
              id="export-sources-filename"
              type="text"
              value={exportFilenameDraft}
              disabled={isExporting}
              onChange={(e) => setExportFilenameDraft(e.target.value)}
              className="w-full h-9 rounded-lg bg-[#141518] border border-[#2f3136] px-3 text-sm text-[#e8eaed] focus:outline-none focus:border-[#8ab4f8] disabled:opacity-60"
            />
          </div>

          <div className="flex items-center gap-2">
            {(['md', 'txt'] as const).map((ext) => {
              const isActive =
                ext === 'txt'
                  ? exportFilenameDraft.trim().toLowerCase().endsWith('.txt')
                  : !exportFilenameDraft.trim().toLowerCase().endsWith('.txt')
              return (
                <button
                  key={ext}
                  type="button"
                  disabled={isExporting}
                  onClick={() => {
                    const stem =
                      exportFilenameDraft.replace(/\.(md|txt)$/i, '').trim() ||
                      sanitizeBaseFilename(notebookName)
                    setExportFilenameDraft(`${stem}.${ext}`)
                  }}
                  className={`flex-1 h-8 rounded-lg border text-xs font-medium transition-colors disabled:opacity-60 ${
                    isActive
                      ? 'bg-[#213352] border-[#8ab4f8]/60 text-[#a8c7fa]'
                      : 'bg-[#141518] border-[#2f3136] text-[#9aa0a6] hover:text-[#e8eaed]'
                  }`}
                >
                  {ext === 'md' ? 'Markdown (.md)' : 'Plain Text (.txt)'}
                </button>
              )
            })}
          </div>

          <div className="rounded-xl bg-[#141518] border border-[#2f3136] px-3 py-2.5 space-y-2.5 hover:border-[#3e424c] transition-colors">
            <label
              htmlFor="export-and-clean-checkbox"
              className="flex items-start gap-2.5 cursor-pointer"
            >
              <input
                id="export-and-clean-checkbox"
                type="checkbox"
                checked={exportAndClean}
                disabled={isExporting}
                onChange={(e) => setExportAndClean(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-[#5f6368] accent-[#8ab4f8] cursor-pointer"
              />
              <div className="space-y-0.5">
                <span className="text-[12.5px] font-medium text-[#e8eaed] block">
                  Export and clean
                </span>
                <span className="text-[11px] leading-relaxed text-[#9aa0a6] block">
                  Uses the LLM + boilerplate scrubber to strip empty bullets, nav/footer links,
                  copyright notices, and filler so your RAG file stays lean and token-efficient.
                </span>
              </div>
            </label>

            {exportAndClean && (
              <div className="pt-2 border-t border-[#25272d] space-y-2">
                <div className="space-y-1">
                  <label
                    htmlFor="export-clean-model-select"
                    className="text-[11px] font-medium text-[#9aa0a6] block"
                  >
                    Cleaning LLM (synced with Settings)
                  </label>
                  <select
                    id="export-clean-model-select"
                    value={appSettings?.export_clean_model || 'auto'}
                    disabled={isExporting || updateAppSettings.isPending}
                    onChange={(e) => {
                      updateAppSettings.mutate({ export_clean_model: e.target.value })
                    }}
                    className="w-full h-8 rounded-lg bg-[#1c1d20] border border-[#2f3136] px-2.5 text-xs text-[#e8eaed] focus:outline-none focus:border-[#8ab4f8] disabled:opacity-60"
                  >
                    <option value="auto">
                      Auto — Cheapest &amp; fastest for provider (e.g. Luna / Haiku / Flash)
                    </option>
                    {languageModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} ({m.provider})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-[#9aa0a6]">Reasoning effort</span>
                  <div className="flex items-center gap-1.5">
                    {(['low', 'medium', 'high'] as const).map((eff) => {
                      const active = (appSettings?.export_clean_effort || 'low') === eff
                      return (
                        <button
                          key={eff}
                          type="button"
                          disabled={isExporting || updateAppSettings.isPending}
                          onClick={() => updateAppSettings.mutate({ export_clean_effort: eff })}
                          className={`px-2.5 py-0.5 rounded-full text-[11px] capitalize border transition-colors disabled:opacity-60 ${
                            active
                              ? 'bg-[#8ab4f8] text-[#0e0f12] font-medium border-[#8ab4f8]'
                              : 'bg-[#1c1d20] text-[#c4c7c5] border-[#2f3136] hover:bg-[#25262b]'
                          }`}
                        >
                          {eff}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>

          {isExporting && (
            <div className="flex items-center gap-2 text-xs text-[#8ab4f8] pt-0.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
              <span>
                {exportAndClean
                  ? 'Cleaning & formatting sources with AI — this may take a moment...'
                  : 'Building export file...'}
              </span>
            </div>
          )}
        </div>
        <DialogFooter>
          <button
            type="button"
            disabled={isExporting}
            onClick={() => setExportDialogOpen(false)}
            className="h-8 px-3 rounded-lg border border-[#2f3136] text-xs text-[#c4c7c5] hover:bg-[#25262b] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirmExport}
            disabled={isExporting || !exportFilenameDraft.trim()}
            className="h-8 px-4 rounded-lg bg-[#8ab4f8] text-[#0e0f12] text-xs font-medium hover:bg-[#a6c8ff] disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {isExporting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {exportAndClean ? 'Cleaning...' : 'Exporting...'}
              </>
            ) : (
              'Choose location & save'
            )}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  if (sourcesCollapsed) {
    return (
      <div className="h-full rounded-2xl bg-[#1c1d20] border border-[#2a2c31] flex flex-col items-center py-3 gap-3">
        <button
          type="button"
          onClick={toggleSources}
          className="h-8 w-8 rounded-lg flex items-center justify-center text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#282a2f] transition-colors"
          title="Expand Sources"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setAddDialogOpen(true)}
          className="h-8 w-8 rounded-lg flex items-center justify-center text-[#c4c7c5] hover:text-[#e8eaed] hover:bg-[#282a2f] transition-colors"
          title="Add sources"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={handleExportSources}
          disabled={isExporting || totalSources === 0}
          className="h-8 w-8 rounded-lg flex items-center justify-center text-[#c4c7c5] hover:text-[#e8eaed] hover:bg-[#282a2f] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="Export sources (.md / .txt)"
        >
          {isExporting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
        </button>
        <AddSourceDialog
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
          defaultNotebookId={notebookId}
        />
        {exportDialog}
      </div>
    )
  }

  return (
    <>
      <div className="h-full flex flex-col rounded-2xl bg-[#1c1d20] border border-[#2a2c31] overflow-hidden">
        {/* Header */}
        <div className="px-4 pt-3.5 pb-2.5 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <h2 className="text-[14px] font-medium text-[#e8eaed]">Sources</h2>
            {totalSources > 0 && (
              <span className="text-[11.5px] text-[#9aa0a6] tabular-nums">
                {normalizedSearch
                  ? `(${filteredSources.length}/${totalSources})`
                  : `(${totalSources})`}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleToggleSearch}
              disabled={totalSources === 0}
              className={`h-7 w-7 rounded-full border flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                searchOpen || normalizedSearch
                  ? 'bg-[#213352] border-[#8ab4f8]/60 text-[#8ab4f8]'
                  : 'bg-[#141518] hover:bg-[#25262b] border-[#2f3136] text-[#c4c7c5] hover:text-[#e8eaed]'
              }`}
              title={searchOpen ? 'Close source filter' : 'Search sources by name or URL'}
              aria-label="Search sources"
              aria-expanded={searchOpen}
            >
              <Search className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleExportSources}
              disabled={isExporting || totalSources === 0}
              className="h-7 px-2.5 rounded-full bg-[#141518] hover:bg-[#25262b] border border-[#2f3136] text-[11.5px] font-medium text-[#c4c7c5] hover:text-[#e8eaed] flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Export all sources into a single RAG-ready .md or .txt file"
              aria-label="Export sources"
            >
              {isExporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#8ab4f8]" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              <span>{isExporting ? 'Exporting...' : 'Export'}</span>
            </button>
            <button
              type="button"
              onClick={toggleSources}
              className="h-7 w-7 rounded-lg flex items-center justify-center text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#282a2f] transition-colors"
              title="Collapse Sources"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Expandable Source Search Bar */}
        {searchOpen && (
          <div className="px-3.5 pb-2.5 flex-shrink-0">
            <div className="relative flex items-center">
              <Search className="h-3.5 w-3.5 text-[#9aa0a6] absolute left-3 pointer-events-none" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setSearchQuery('')
                    setSearchOpen(false)
                  }
                }}
                placeholder="Filter sources by name, URL, or file..."
                aria-label="Filter sources"
                className="w-full h-8 pl-8 pr-7 rounded-full bg-[#141518] border border-[#2f3136] focus:border-[#8ab4f8] focus:outline-none text-[12px] text-[#e8eaed] placeholder:text-[#7c828c]"
              />
              <button
                type="button"
                onClick={() => {
                  if (searchQuery) {
                    setSearchQuery('')
                    searchInputRef.current?.focus()
                  } else {
                    setSearchOpen(false)
                  }
                }}
                className="absolute right-2 h-5 w-5 rounded-full flex items-center justify-center text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#25262b] transition-colors"
                title={searchQuery ? 'Clear filter' : 'Close search'}
                aria-label={searchQuery ? 'Clear filter' : 'Close search'}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
        )}

        {/* Action Pill Buttons (matching NotebookLM) */}
        <div className="px-3.5 pb-3 flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => setAddDialogOpen(true)}
            className="flex-1 h-9 px-3 rounded-full bg-[#141518] hover:bg-[#25262b] border border-[#2f3136] text-[#e8eaed] text-[12.5px] font-medium flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Plus className="h-3.5 w-3.5" />
            Add sources
          </button>
          <button
            type="button"
            onClick={() => setNoteEditorOpen(true)}
            className="flex-1 h-9 px-3 rounded-full bg-[#141518] hover:bg-[#25262b] border border-[#2f3136] text-[#e8eaed] text-[12.5px] font-medium flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Plus className="h-3.5 w-3.5" />
            Create note
          </button>
        </div>

        {/* Subtle Link Existing Sources Trigger */}
        <div className="px-4 pb-2 flex items-center justify-between text-[11.5px] text-[#9aa0a6] flex-shrink-0">
          <button
            type="button"
            onClick={() => setAddExistingDialogOpen(true)}
            className="inline-flex items-center gap-1 hover:text-[#e8eaed] transition-colors"
          >
            <Link2 className="h-3 w-3" /> Link existing
          </button>

          {totalSources > 0 && (
            <button
              type="button"
              onClick={handleToggleAll}
              className="inline-flex items-center gap-2 text-[#c4c7c5] hover:text-[#e8eaed] transition-colors"
            >
              <span>Select all</span>
              <span
                className={`h-4 w-4 rounded-[4px] border flex items-center justify-center transition-colors ${
                  allSelected
                    ? 'bg-[#e8eaed] border-[#e8eaed] text-[#0e0f12]'
                    : 'border-[#5f6368] bg-transparent'
                }`}
              >
                {allSelected && <Check className="h-3 w-3 stroke-[3]" />}
              </span>
            </button>
          )}
        </div>

        {/* Source Rows */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto min-h-0 px-2.5 pb-3">
          {isLoading ? (
            <div className="flex items-center justify-center py-10">
              <LoadingSpinner />
            </div>
          ) : !sources || sources.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center px-4 py-12 text-[#9aa0a6]">
              <FileText className="h-8 w-8 mb-3 opacity-40" />
              <p className="text-xs font-medium text-[#c4c7c5] mb-1">Saved sources will appear here</p>
              <p className="text-[11px] leading-relaxed">
                Click Add sources above to add PDFs, GitHub repos, websites, YouTube links, or pasted text.
              </p>
            </div>
          ) : normalizedSearch && filteredSources.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center px-4 py-10 text-[#9aa0a6]">
              <Search className="h-6 w-6 mb-2.5 opacity-40" />
              <p className="text-xs font-medium text-[#c4c7c5] mb-1">
                No sources match &ldquo;{searchQuery.trim()}&rdquo;
              </p>
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('')
                  searchInputRef.current?.focus()
                }}
                className="mt-1 text-[11.5px] text-[#8ab4f8] hover:underline"
              >
                Clear search
              </button>
            </div>
          ) : (
            <TooltipProvider delayDuration={250}>
              <div className="space-y-0.5">
                {filteredSources.map((source) => {
                  const isIncluded = (contextSelections?.[source.id] ?? 'off') !== 'off'
                  const fullTitle = source.title || 'Untitled source'
                  return (
                    <div
                      key={source.id}
                      className="group flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-[#26282e] transition-colors cursor-pointer"
                      onClick={() => openModal('source', source.id)}
                    >
                      {getSourceIcon(source)}

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="flex-1 min-w-0 text-[13px] text-[#e3e5e8] truncate">
                            {fullTitle}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent
                          side="right"
                          align="center"
                          sideOffset={10}
                          className="max-w-[360px] text-wrap rounded-xl bg-[#25272d] border border-[#3a3d46] text-[#e8eaed] px-3 py-2 shadow-2xl z-50"
                        >
                          <p className="text-xs font-medium leading-snug break-words">
                            {fullTitle}
                          </p>
                          {source.asset?.url && (
                            <p className="text-[11px] text-[#9aa0a6] mt-1 break-all leading-snug">
                              {source.asset.url}
                            </p>
                          )}
                        </TooltipContent>
                      </Tooltip>

                    {/* Hover actions menu */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => e.stopPropagation()}
                          className="h-6 w-6 rounded-md flex items-center justify-center text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#32343b] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity shrink-0"
                          aria-label="Source actions"
                        >
                          <MoreVertical className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="bg-[#1c1d20] border-[#2f3136] text-[#e8eaed] w-44"
                      >
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation()
                            handleRetry(source.id)
                          }}
                          className="focus:bg-[#282a2f] focus:text-[#e8eaed]"
                        >
                          <RefreshCw className="h-3.5 w-3.5 mr-2" /> Refresh / Retry
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation()
                            setSourceToRemove(source.id)
                            setRemoveDialogOpen(true)
                          }}
                          className="focus:bg-[#282a2f] focus:text-[#e8eaed]"
                        >
                          <Unlink className="h-3.5 w-3.5 mr-2" /> Remove from notebook
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation()
                            setSourceToDelete(source.id)
                            setDeleteDialogOpen(true)
                          }}
                          className="text-red-400 focus:bg-[#282a2f] focus:text-red-400"
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete source
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>

                    {/* Inclusion Checkbox (matching NotebookLM) */}
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={isIncluded}
                      aria-label={`Include ${source.title || 'source'} in conversation`}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleToggleSource(source.id)
                      }}
                      className={`h-4 w-4 rounded-[4px] border flex items-center justify-center shrink-0 transition-colors ${
                        isIncluded
                          ? 'bg-[#e8eaed] border-[#e8eaed] text-[#0e0f12]'
                          : 'border-[#5f6368] bg-transparent hover:border-[#9aa0a6]'
                      }`}
                    >
                      {isIncluded && <Check className="h-3 w-3 stroke-[3]" />}
                    </button>
                  </div>
                )
              })}

              {isFetchingNextPage && (
                <div className="flex items-center justify-center py-3">
                  <Loader2 className="h-4 w-4 animate-spin text-[#9aa0a6]" />
                </div>
              )}
              </div>
            </TooltipProvider>
          )}
        </div>
      </div>

      <AddSourceDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        defaultNotebookId={notebookId}
      />

      <AddExistingSourceDialog
        open={addExistingDialogOpen}
        onOpenChange={setAddExistingDialogOpen}
        notebookId={notebookId}
        onSuccess={onRefresh}
      />

      <NoteEditorDialog
        open={noteEditorOpen}
        onOpenChange={setNoteEditorOpen}
        notebookId={notebookId}
      />

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t('sources.delete')}
        description={t('sources.deleteConfirm')}
        confirmText={t('common.delete')}
        onConfirm={handleDeleteConfirm}
        isLoading={deleteSource.isPending}
        confirmVariant="destructive"
      />

      <ConfirmDialog
        open={removeDialogOpen}
        onOpenChange={setRemoveDialogOpen}
        title={t('sources.removeFromNotebook')}
        description={t('sources.removeConfirm')}
        confirmText={t('common.remove')}
        onConfirm={handleRemoveConfirm}
        isLoading={removeFromNotebook.isPending}
        confirmVariant="default"
      />

      {exportDialog}
    </>
  )
}
