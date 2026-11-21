'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { SourceListResponse } from '@/lib/types/api'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Plus,
  FileText,
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
} from 'lucide-react'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { AddSourceDialog } from '@/components/sources/AddSourceDialog'
import { AddExistingSourceDialog } from '@/components/sources/AddExistingSourceDialog'
import { NoteEditorDialog } from './NoteEditorDialog'
import {
  useDeleteSource,
  useRetrySource,
  useRemoveSourceFromNotebook,
} from '@/lib/hooks/use-sources'
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
    return <Globe className="h-4 w-4 text-[#f97316] shrink-0" />
  }
  if (source.asset?.file_path) {
    return <FileText className="h-4 w-4 text-[#60a5fa] shrink-0" />
  }
  return <AlignLeft className="h-4 w-4 text-emerald-400 shrink-0" />
}

export function SourcesColumn({
  sources,
  isLoading,
  notebookId,
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

  const { openModal } = useModalManager()
  const deleteSource = useDeleteSource()
  const retrySource = useRetrySource()
  const removeFromNotebook = useRemoveSourceFromNotebook()
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
        <AddSourceDialog
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
          defaultNotebookId={notebookId}
        />
      </div>
    )
  }

  return (
    <>
      <div className="h-full flex flex-col rounded-2xl bg-[#1c1d20] border border-[#2a2c31] overflow-hidden">
        {/* Header */}
        <div className="px-4 pt-3.5 pb-2.5 flex items-center justify-between flex-shrink-0">
          <h2 className="text-[14px] font-medium text-[#e8eaed]">Sources</h2>
          <button
            type="button"
            onClick={toggleSources}
            className="h-7 w-7 rounded-lg flex items-center justify-center text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#282a2f] transition-colors"
            title="Collapse Sources"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>

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
                Click Add sources above to add PDFs, websites, YouTube links, or pasted text.
              </p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {sources.map((source) => {
                const isIncluded = (contextSelections?.[source.id] ?? 'off') !== 'off'
                return (
                  <div
                    key={source.id}
                    className="group flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-[#26282e] transition-colors cursor-pointer"
                    onClick={() => openModal('source', source.id)}
                  >
                    {getSourceIcon(source)}

                    <span className="flex-1 min-w-0 text-[13px] text-[#e3e5e8] truncate">
                      {source.title || 'Untitled source'}
                    </span>

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
    </>
  )
}
