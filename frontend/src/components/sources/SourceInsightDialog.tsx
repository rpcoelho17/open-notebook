'use client'

import { useState, useEffect, useMemo } from 'react'
import { usePathname } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FileText, StickyNote } from 'lucide-react'
import {MarkdownRenderer} from '@/components/ui/markdown-renderer'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useInsight, useSaveInsightAsNote } from '@/lib/hooks/use-insights'
import { useNotebooks } from '@/lib/hooks/use-notebooks'
import { useModalManager } from '@/lib/hooks/use-modal-manager'
import { useTranslation } from '@/lib/hooks/use-translation'
import { ContentUnavailable } from '@/components/common/ContentUnavailable'
import { isNotFoundError } from '@/lib/utils/error-handler'

interface SourceInsightDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  insight?: {
    id: string
    insight_type?: string
    content?: string
    created?: string | null
    source_id?: string
  }
  onDelete?: (insightId: string) => Promise<void>
  // When set, "Save as note" saves straight to this notebook; otherwise the user picks one
  notebookId?: string
}

export function SourceInsightDialog({ open, onOpenChange, insight, onDelete, notebookId }: SourceInsightDialogProps) {
  const { t } = useTranslation()
  const { openModal } = useModalManager()
  const pathname = usePathname()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  // Detect active notebook from route (/notebooks/<id>) when no notebookId prop was passed
  const routeNotebookId = useMemo(() => {
    const match = pathname?.match(/^\/notebooks\/([^/]+)/)
    return match ? decodeURIComponent(match[1]) : undefined
  }, [pathname])

  // Ensure insight ID has 'source_insight:' prefix for API calls
  const insightIdWithPrefix = insight?.id
    ? (insight.id.includes(':') ? insight.id : `source_insight:${insight.id}`)
    : ''

  const { data: fetchedInsight, isLoading, isError, error } = useInsight(insightIdWithPrefix, { enabled: open && !!insight?.id })

  // Use fetched data if available, otherwise fall back to passed-in insight.
  // On fetch error there is nothing trustworthy to show (the passed-in data
  // may reference a deleted item), so every derived field goes blank here.
  const displayInsight = isError ? undefined : (fetchedInsight ?? insight)

  // Get source_id from fetched data (preferred) or passed-in insight
  const sourceId = displayInsight?.source_id

  const handleViewSource = () => {
    if (sourceId) {
      openModal('source', sourceId)
    }
  }

  const handleDelete = async () => {
    if (!insight?.id || !onDelete) return
    setIsDeleting(true)
    try {
      await onDelete(insight.id)
      onOpenChange(false)
    } finally {
      setIsDeleting(false)
      setShowDeleteConfirm(false)
    }
  }

  // Reset delete confirmation when dialog closes
  useEffect(() => {
    if (!open) {
      setShowDeleteConfirm(false)
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2 pr-8">
            <span>{t('sources.sourceInsight')}</span>
            <div className="flex items-center gap-2">
              {displayInsight?.insight_type && (
                <Badge variant="outline" className="gap-1.5 text-xs uppercase">
                  <span className="h-1.5 w-1.5 rounded-full bg-teal" aria-hidden="true" />
                  {displayInsight.insight_type}
                </Badge>
              )}
              {sourceId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleViewSource}
                  className="gap-1"
                >
                  <FileText className="h-3 w-3" />
                  {t('sources.viewSource')}
                </Button>
              )}
            </div>
          </DialogTitle>
        </DialogHeader>

        {showDeleteConfirm ? (
          <div className="flex flex-col items-center justify-center py-8 gap-4">
            <p className="text-center text-muted-foreground">
              {t('sources.deleteInsightConfirm').split(/[?？]/)[0]}?<br />
              <span className="text-sm">{t('sources.deleteInsightConfirm').split(/[?？]/)[1]?.trim() || t('common.deleteForever')}</span>
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={isDeleting}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={isDeleting}
              >
                {isDeleting ? t('common.deleting') : t('common.delete')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto min-h-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-10">
                <span className="text-sm text-muted-foreground">{t('common.loading')}</span>
              </div>
            ) : isError ? (
              <ContentUnavailable
                variant={isNotFoundError(error) ? 'not-found' : 'error'}
                onClose={() => onOpenChange(false)}
              />
            ) : displayInsight ? (
              <MarkdownRenderer>
                {displayInsight.content}
              </MarkdownRenderer>
            ) : (
              <p className="text-sm text-muted-foreground">{t('sources.noInsightSelected')}</p>
            )}
          </div>
        )}

        {!showDeleteConfirm && !isLoading && !isError && displayInsight && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
            {notebookId ? (
              <SaveAsNoteButton
                insightId={insightIdWithPrefix}
                notebookId={notebookId}
                onSaved={() => onOpenChange(false)}
              />
            ) : (
              <SaveAsNoteWithPicker
                insightId={insightIdWithPrefix}
                defaultNotebookId={routeNotebookId}
                onSaved={() => onOpenChange(false)}
              />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function SaveAsNoteButton({
  insightId,
  notebookId,
  onSaved,
}: {
  insightId: string
  notebookId: string
  onSaved?: () => void
}) {
  const { t } = useTranslation()
  const saveAsNote = useSaveInsightAsNote()

  const handleSave = async () => {
    if (!notebookId) return
    try {
      await saveAsNote.mutateAsync({ insightId, notebookId })
      onSaved?.()
    } catch {
      // Error toast is already displayed by useSaveInsightAsNote
    }
  }

  return (
    <Button
      size="sm"
      className="gap-1"
      onClick={handleSave}
      disabled={!notebookId || saveAsNote.isPending}
    >
      <StickyNote className="h-3 w-3" />
      {saveAsNote.isPending ? t('common.saving') : t('sources.saveAsNote')}
    </Button>
  )
}

// Mounted only without an explicit notebookId prop, pre-selecting the active route notebook when available
function SaveAsNoteWithPicker({
  insightId,
  defaultNotebookId,
  onSaved,
}: {
  insightId: string
  defaultNotebookId?: string
  onSaved?: () => void
}) {
  const { t } = useTranslation()
  const { data: notebooks, isLoading } = useNotebooks(false) // false = not archived
  const [pickedId, setPickedId] = useState('')

  // Preselect active route notebook if it exists in the list, or fall back when only one notebook exists
  const matchedRouteId =
    defaultNotebookId && notebooks?.some((nb) => nb.id === defaultNotebookId)
      ? defaultNotebookId
      : ''
  const notebookId =
    pickedId || matchedRouteId || (notebooks?.length === 1 ? notebooks[0].id : '')

  if (!isLoading && !notebooks?.length) {
    return <p className="text-sm text-muted-foreground">{t('sources.noNotebooksFound')}</p>
  }

  return (
    <>
      <Select value={notebookId} onValueChange={setPickedId} disabled={isLoading}>
        <SelectTrigger className="w-56" aria-label={t('sources.chooseNotebook')}>
          <SelectValue placeholder={t('sources.chooseNotebook')} />
        </SelectTrigger>
        <SelectContent>
          {notebooks?.map(nb => (
            <SelectItem key={nb.id} value={nb.id}>{nb.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <SaveAsNoteButton insightId={insightId} notebookId={notebookId} onSaved={onSaved} />
    </>
  )
}
