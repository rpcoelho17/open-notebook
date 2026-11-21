'use client'

import { useState, useEffect } from 'react'
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
        <div className="hidden lg:flex h-full min-h-0 gap-3 flex-row">
          {/* Column 1: Sources */}
          <div
            className={cn(
              'h-full transition-all duration-150 flex-shrink-0',
              sourcesCollapsed ? 'w-14' : 'w-[285px] xl:w-[305px]'
            )}
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

          {/* Column 2: Center Chat Canvas */}
          <div className="flex-1 min-w-0 h-full">
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
