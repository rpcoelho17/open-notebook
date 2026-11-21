'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { NotebookHeader } from '../components/NotebookHeader'
import { SourcesColumn } from '../components/SourcesColumn'
import { StudioColumn } from '../components/StudioColumn'
import { ChatColumn } from '../components/ChatColumn'
import { NotebookSettingsDialog } from '@/components/notebooks/NotebookSettingsDialog'
import { useNotebook } from '@/lib/hooks/use-notebooks'
import { useNotebookSources } from '@/lib/hooks/use-sources'
import { useNotes } from '@/lib/hooks/use-notes'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { useNotebookColumnsStore } from '@/lib/stores/notebook-columns-store'
import { useIsDesktop } from '@/lib/hooks/use-media-query'
import { useTranslation } from '@/lib/hooks/use-translation'
import { cn } from '@/lib/utils'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ArrowLeft, FileText, Sparkles, MessageSquare } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import {
  applyBulkSourceContext,
  computeSourceSelections,
  computeNoteSelections,
  type SourceContextDefault,
  type SourceBulkAction,
  type NoteContextDefault,
} from '@/lib/utils/source-context'

import type { ContextMode, ContextSelections, NoteContextMode } from '@/lib/types/notebook-context'
export type { ContextMode, ContextSelections, NoteContextMode }

export default function NotebookPage() {
  const { t } = useTranslation()
  const params = useParams()

  const notebookId = params?.id ? decodeURIComponent(params.id as string) : ''

  const { data: notebook, isLoading: notebookLoading } = useNotebook(notebookId)
  const {
    sources,
    isLoading: sourcesLoading,
    refetch: refetchSources,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useNotebookSources(notebookId)
  const { data: notes, isLoading: notesLoading } = useNotes(notebookId)

  const { sourcesCollapsed, notesCollapsed } = useNotebookColumnsStore()
  const isDesktop = useIsDesktop()

  const [mobileActiveTab, setMobileActiveTab] = useState<'sources' | 'chat' | 'studio'>('chat')
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Resizable Sources column width (persisted in localStorage, 220px–560px)
  const [sourcesWidth, setSourcesWidth] = useState<number>(300)
  const [isResizingSources, setIsResizingSources] = useState(false)
  const resizeStartXRef = useRef<number>(0)
  const resizeStartWidthRef = useRef<number>(300)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const saved = Number(localStorage.getItem('open_notebook_sources_width'))
    if (Number.isFinite(saved) && saved >= 220 && saved <= 560) {
      setSourcesWidth(saved)
    }
  }, [])

  const handleSourcesResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      resizeStartXRef.current = e.clientX
      resizeStartWidthRef.current = sourcesWidth
      setIsResizingSources(true)
    },
    [sourcesWidth]
  )

  useEffect(() => {
    if (!isResizingSources) return
    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - resizeStartXRef.current
      const next = Math.min(560, Math.max(220, resizeStartWidthRef.current + delta))
      setSourcesWidth(next)
    }
    const handleMouseUp = () => {
      setIsResizingSources(false)
      if (typeof window !== 'undefined') {
        localStorage.setItem('open_notebook_sources_width', String(sourcesWidth))
      }
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizingSources, sourcesWidth])

  const [contextSelections, setContextSelections] = useState<ContextSelections>({
    sources: {},
    notes: {},
  })

  const [sourceContextDefault, setSourceContextDefault] = useState<SourceContextDefault>('include')
  const [noteContextDefault] = useState<NoteContextDefault>('include')

  useEffect(() => {
    if (sources && sources.length > 0) {
      setContextSelections((prev) => ({
        ...prev,
        sources: computeSourceSelections(prev.sources, sources, sourceContextDefault),
      }))
    }
  }, [sources, sourceContextDefault])

  useEffect(() => {
    if (notes && notes.length > 0) {
      setContextSelections((prev) => ({
        ...prev,
        notes: computeNoteSelections(prev.notes, notes, noteContextDefault),
      }))
    }
  }, [notes, noteContextDefault])

  const handleSourceContextModeChange = (sourceId: string, mode: ContextMode) => {
    setContextSelections((prev) => ({
      ...prev,
      sources: {
        ...prev.sources,
        [sourceId]: mode,
      },
    }))
  }

  const handleBulkSourceContext = (action: SourceBulkAction) => {
    setSourceContextDefault(action)
    setContextSelections((prev) => ({
      ...prev,
      sources: applyBulkSourceContext(prev.sources, sources ?? [], action),
    }))
  }

  if (notebookLoading) {
    return (
      <div className="min-h-screen bg-[#0e0f12] flex items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (!notebook) {
    return (
      <div className="min-h-screen bg-[#0e0f12] text-[#e8eaed] p-8 flex flex-col items-center justify-center">
        <h1 className="text-2xl font-medium mb-3">{t('notebooks.notFound')}</h1>
        <p className="text-[#9aa0a6] text-sm mb-6">{t('notebooks.notFoundDesc')}</p>
        <Button asChild variant="outline" className="rounded-full bg-[#1c1d20] border-[#2f3136] text-[#e8eaed]">
          <Link href="/notebooks">
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t('navigation.notebooks')}
          </Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="h-screen w-screen bg-[#0e0f12] text-[#e8eaed] flex flex-col overflow-hidden">
      {/* Top NotebookLM Header Bar */}
      <NotebookHeader notebook={notebook} onOpenSettings={() => setSettingsOpen(true)} />

      {/* Main 3-Column Workspace: Sources (Left) | Chat (Center) | Studio (Right) */}
      <div className="flex-1 min-h-0 px-3 pb-3 flex flex-col overflow-hidden">
        {/* Mobile Tabbed View */}
        {!isDesktop && (
          <>
            <div className="lg:hidden mb-3">
              <Tabs
                value={mobileActiveTab}
                onValueChange={(value) => setMobileActiveTab(value as 'sources' | 'chat' | 'studio')}
              >
                <TabsList className="grid w-full grid-cols-3 bg-[#1c1d20] border border-[#2a2c31]">
                  <TabsTrigger value="sources" className="gap-1.5 text-xs">
                    <FileText className="h-3.5 w-3.5" />
                    Sources
                  </TabsTrigger>
                  <TabsTrigger value="chat" className="gap-1.5 text-xs">
                    <MessageSquare className="h-3.5 w-3.5" />
                    Chat
                  </TabsTrigger>
                  <TabsTrigger value="studio" className="gap-1.5 text-xs">
                    <Sparkles className="h-3.5 w-3.5" />
                    Studio
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            <div className="flex-1 min-h-0 overflow-hidden lg:hidden">
              {mobileActiveTab === 'sources' && (
                <SourcesColumn
                  sources={sources}
                  isLoading={sourcesLoading}
                  notebookId={notebookId}
                  notebookName={notebook?.name}
                  onRefresh={refetchSources}
                  contextSelections={contextSelections.sources}
                  onContextModeChange={handleSourceContextModeChange}
                  onBulkContextModeChange={handleBulkSourceContext}
                  hasNextPage={hasNextPage}
                  isFetchingNextPage={isFetchingNextPage}
                  fetchNextPage={fetchNextPage}
                />
              )}
              {mobileActiveTab === 'chat' && (
                <ChatColumn
                  notebookId={notebookId}
                  contextSelections={contextSelections}
                  sources={sources}
                  sourcesLoading={sourcesLoading}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
              )}
              {mobileActiveTab === 'studio' && (
                <StudioColumn
                  notes={notes}
                  isLoading={notesLoading}
                  notebookId={notebookId}
                  notebookName={notebook?.name}
                  sources={sources}
                  contextSelections={contextSelections}
                />
              )}
            </div>
          </>
        )}

        {/* Desktop 3-Column NotebookLM Layout */}
        <div className="hidden lg:flex h-full min-h-0 flex-row">
          {/* Column 1: Sources (resizable via drag handle on right edge) */}
          <div
            className={cn(
              'h-full flex-shrink-0',
              !isResizingSources && 'transition-[width] duration-150',
              sourcesCollapsed && 'w-14'
            )}
            style={sourcesCollapsed ? undefined : { width: `${sourcesWidth}px` }}
          >
            <SourcesColumn
              sources={sources}
              isLoading={sourcesLoading}
              notebookId={notebookId}
              notebookName={notebook?.name}
              onRefresh={refetchSources}
              contextSelections={contextSelections.sources}
              onContextModeChange={handleSourceContextModeChange}
              onBulkContextModeChange={handleBulkSourceContext}
              hasNextPage={hasNextPage}
              isFetchingNextPage={isFetchingNextPage}
              fetchNextPage={fetchNextPage}
            />
          </div>

          {/* Drag-to-Resize Handle between Sources and Chat */}
          {!sourcesCollapsed ? (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize Sources column"
              title="Drag to resize Sources column (double-click to reset)"
              onMouseDown={handleSourcesResizeStart}
              onDoubleClick={() => {
                setSourcesWidth(300)
                if (typeof window !== 'undefined') {
                  localStorage.setItem('open_notebook_sources_width', '300')
                }
              }}
              className="w-3 flex-shrink-0 cursor-col-resize flex items-center justify-center group"
            >
              <div
                className={cn(
                  'w-[3px] h-16 rounded-full transition-colors',
                  isResizingSources
                    ? 'bg-[#4285f4]'
                    : 'bg-transparent group-hover:bg-[#4285f4]/60'
                )}
              />
            </div>
          ) : (
            <div className="w-3 flex-shrink-0" />
          )}

          {/* Column 2: Center Chat Canvas */}
          <div className="flex-1 min-w-0 h-full mr-3">
            <ChatColumn
              notebookId={notebookId}
              contextSelections={contextSelections}
              sources={sources}
              sourcesLoading={sourcesLoading}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          </div>

          {/* Column 3: Studio & Saved Notes */}
          <div
            className={cn(
              'h-full transition-all duration-150 flex-shrink-0',
              notesCollapsed ? 'w-14' : 'w-[310px] xl:w-[335px]'
            )}
          >
            <StudioColumn
              notes={notes}
              isLoading={notesLoading}
              notebookId={notebookId}
              notebookName={notebook?.name}
              sources={sources}
              contextSelections={contextSelections}
            />
          </div>
        </div>
      </div>

      {/* Top-Right Gear: Voice & Studio Settings Dialog */}
      <NotebookSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  )
}
