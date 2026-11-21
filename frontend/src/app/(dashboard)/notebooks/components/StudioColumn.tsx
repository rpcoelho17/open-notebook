'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { NoteResponse, SourceListResponse } from '@/lib/types/api'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AudioLines,
  FileText,
  BarChart3,
  StickyNote,
  PanelRightClose,
  PanelRightOpen,
  MoreVertical,
  Trash2,
  Loader2,
  Sparkles,
  Wand2,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { NoteEditorDialog } from './NoteEditorDialog'
import {
  InfographicViewerDialog,
  INFOGRAPHIC_MARKER,
  isInfographicNote,
} from '@/components/notebooks/InfographicViewerDialog'
import { GeneratePodcastDialog } from '@/components/podcasts/GeneratePodcastDialog'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { useCreateNote, useDeleteNote } from '@/lib/hooks/use-notes'
import { useTransformations } from '@/lib/hooks/use-transformations'
import { usePodcastEpisodes } from '@/lib/hooks/use-podcasts'
import { useNotebookColumnsStore } from '@/lib/stores/notebook-columns-store'
import { useVoiceSettingsStore } from '@/lib/stores/voice-settings-store'
import { chatApi } from '@/lib/api/chat'
import type { ContextSelections } from '../[id]/page'
import { toast } from 'sonner'

const BRIDGE_CHAT_URL = 'http://127.0.0.1:8088/v1/chat/completions'
const INFOGRAPHIC_MODEL = 'gpt-6.2-sol'
const REPORT_MODEL = 'gpt-6-luna'

interface StudioColumnProps {
  notes?: NoteResponse[]
  isLoading: boolean
  notebookId: string
  notebookName?: string
  sources?: SourceListResponse[]
  contextSelections: ContextSelections
}

function getNoteKind(note: NoteResponse): { label: string; kind: 'infographic' | 'report' | 'note' } {
  if (isInfographicNote(note)) {
    return { label: 'Infographic', kind: 'infographic' }
  }
  const titleLower = (note.title || '').toLowerCase()
  if (
    titleLower.includes('briefing') ||
    titleLower.includes('report') ||
    titleLower.includes('study guide') ||
    titleLower.includes('summary')
  ) {
    return { label: 'Briefing Doc', kind: 'report' }
  }
  return { label: note.note_type === 'ai' ? 'Saved Note' : 'Note', kind: 'note' }
}

function compactRelativeTime(dateStr: string): string {
  try {
    const raw = formatDistanceToNow(new Date(dateStr), { addSuffix: true })
    return raw
      .replace('less than a minute ago', 'just now')
      .replace('about ', '')
      .replace(' minutes ago', 'm ago')
      .replace(' minute ago', 'm ago')
      .replace(' hours ago', 'h ago')
      .replace(' hour ago', 'h ago')
      .replace(' days ago', 'd ago')
      .replace(' day ago', 'd ago')
  } catch {
    return 'just now'
  }
}

export function StudioColumn({
  notes,
  isLoading,
  notebookId,
  notebookName = 'Notebook',
  sources = [],
  contextSelections,
}: StudioColumnProps) {
  const router = useRouter()
  const { notesCollapsed, toggleNotes } = useNotebookColumnsStore()
  const { unreadNoteIds, markNoteUnread, markNoteRead } = useVoiceSettingsStore()

  const createNote = useCreateNote()
  const deleteNote = useDeleteNote()
  const { data: transformations = [] } = useTransformations()
  const { episodes = [] } = usePodcastEpisodes({ autoRefresh: true })

  // Dialog states
  const [podcastOpen, setPodcastOpen] = useState(false)
  const [reportsDialogOpen, setReportsDialogOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingNote, setEditingNote] = useState<NoteResponse | undefined>()
  const [viewingInfographic, setViewingInfographic] = useState<NoteResponse | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [noteToDelete, setNoteToDelete] = useState<string | null>(null)

  // Generation loading states
  const [isGeneratingInfographic, setIsGeneratingInfographic] = useState(false)
  const [generatingReportName, setGeneratingReportName] = useState<string | null>(null)

  const selectedSourcesCount = sources.filter(
    (s) => (contextSelections.sources[s.id] ?? 'off') !== 'off'
  ).length

  // Helper: fetch active notebook sources text via Open Notebook's buildContext API
  const fetchSelectedSourcesText = async (): Promise<string> => {
    const contextConfig: { sources: Record<string, string>; notes: Record<string, string> } = {
      sources: {},
      notes: {},
    }
    sources.forEach((s) => {
      const mode = contextSelections.sources[s.id] ?? 'full'
      if (mode === 'full') contextConfig.sources[s.id] = 'full content'
      else if (mode === 'insights') contextConfig.sources[s.id] = 'insights'
    })
    if (Object.keys(contextConfig.sources).length === 0 && sources.length > 0) {
      sources.forEach((s) => {
        contextConfig.sources[s.id] = 'full content'
      })
    }

    const res = await chatApi.buildContext({
      notebook_id: notebookId,
      context_config: contextConfig,
    })

    const built = res.context as { sources?: Array<Record<string, unknown>> }
    const chunks = (built?.sources || []).map((s) => {
      const title = String(s.title || s.name || 'Source')
      const body = String(s.full_text || s.content || s.text || JSON.stringify(s))
      return `### Source: ${title}\n${body.slice(0, 18000)}`
    })
    return chunks.join('\n\n')
  }

  // Generate visual SVG/HTML Infographic via GPT-6.2-Sol
  const handleGenerateInfographic = async () => {
    if (sources.length === 0) {
      toast.info('Add at least one source first to generate an infographic.')
      return
    }
    if (isGeneratingInfographic) return

    setIsGeneratingInfographic(true)
    toast.info('Generating visual infographic with GPT-6.2-Sol...')

    try {
      const sourceText = await fetchSelectedSourcesText()
      const prompt = `Create a stunning, publication-grade, self-contained single-file HTML/CSS/SVG visual infographic summarizing the notebook "${notebookName}" based strictly on the sources below.

Design requirements:
- Dark modern executive infographic theme (deep slate background #0e0f13, elevated cards #181a20, crisp typography using system-ui/Inter, subtle borders #2a2d36, vivid accents in blue #60a5fa, violet #a78bfa, emerald #34d399, amber #fbbf24).
- Include:
  1. Hero header banner with bold title, subtitle, and 3-4 key takeaway stat/metric pills.
  2. Visual architecture / flow diagram using clean inline SVG (arrows, boxes, icons) showing how the core concept works.
  3. Comparison or breakdown cards (e.g. Before vs After, Key Pillars, or Step-by-Step workflow).
  4. Compact bottom "Key Takeaways" strip.
- Must be 100% self-contained (inline CSS + inline SVG, no external CDN dependencies), responsive, and fit cleanly without horizontal overflow.
- Output ONLY raw valid HTML starting with <!DOCTYPE html> and ending with </html>. Do NOT wrap in markdown code fences.

SOURCES:
${sourceText.slice(0, 28000)}`

      const res = await fetch(BRIDGE_CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: INFOGRAPHIC_MODEL,
          reasoning_effort: 'low',
          messages: [
            {
              role: 'system',
              content:
                'You are an expert information designer who outputs clean, self-contained HTML + inline SVG visual infographics. Output raw HTML only, with no markdown fences or preamble.',
            },
            { role: 'user', content: prompt },
          ],
          stream: false,
        }),
      })

      if (!res.ok) {
        throw new Error(`Bridge returned HTTP ${res.status}`)
      }

      const data = await res.json()
      let rawHtml: string = data?.choices?.[0]?.message?.content || ''
      rawHtml = rawHtml
        .replace(/^```html\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim()

      if (!rawHtml.toLowerCase().includes('<html') && !rawHtml.toLowerCase().includes('<svg')) {
        throw new Error('Model did not return valid HTML/SVG infographic output.')
      }

      const created = await createNote.mutateAsync({
        notebook_id: notebookId,
        title: `Infographic: ${notebookName}`,
        content: `${INFOGRAPHIC_MARKER}\n${rawHtml}`,
        note_type: 'ai',
      })

      if (created?.id) {
        markNoteUnread(created.id)
        setViewingInfographic(created)
      }
      toast.success('Infographic generated with GPT-6.2-Sol!')
    } catch (err: unknown) {
      console.error('Infographic error:', err)
      toast.error(`Infographic failed: ${(err as Error)?.message || 'Check Codex bridge'}`)
    } finally {
      setIsGeneratingInfographic(false)
    }
  }

  // Generate a Report / Transformation and save as a 1-line Studio card
  const handleRunReport = async (reportTitle: string, instructions: string) => {
    if (sources.length === 0) {
      toast.info('Add at least one source first to generate a report.')
      return
    }
    setReportsDialogOpen(false)
    setGeneratingReportName(reportTitle)
    toast.info(`Generating ${reportTitle}...`)

    try {
      const sourceText = await fetchSelectedSourcesText()
      const res = await fetch(BRIDGE_CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: REPORT_MODEL,
          reasoning_effort: 'low',
          messages: [
            {
              role: 'system',
              content:
                'You are an expert research analyst. Write clear, well-structured Markdown grounded strictly in the provided sources. Start with a concise # Title line.',
            },
            {
              role: 'user',
              content: `${instructions}\n\nNOTEBOOK: ${notebookName}\n\nSOURCES:\n${sourceText.slice(0, 28000)}`,
            },
          ],
          stream: false,
        }),
      })

      if (!res.ok) throw new Error(`Bridge returned HTTP ${res.status}`)
      const data = await res.json()
      const content: string = (data?.choices?.[0]?.message?.content || '').trim()
      if (!content) throw new Error('Empty report returned')

      // Extract clean 1-line title from first heading or fallback
      const headingMatch = content.match(/^#{1,3}\s+(.+)$/m)
      const shortTitle = headingMatch
        ? headingMatch[1].replace(/[*_`]/g, '').trim().slice(0, 72)
        : `${reportTitle}: ${notebookName}`.slice(0, 72)

      const created = await createNote.mutateAsync({
        notebook_id: notebookId,
        title: shortTitle,
        content,
        note_type: 'ai',
      })
      if (created?.id) markNoteUnread(created.id)
      toast.success(`${reportTitle} saved to Studio!`)
    } catch (err: unknown) {
      console.error('Report generation error:', err)
      toast.error(`Failed to generate report: ${(err as Error)?.message || 'Check Codex bridge'}`)
    } finally {
      setGeneratingReportName(null)
    }
  }

  const handleOpenNoteCard = (note: NoteResponse) => {
    markNoteRead(note.id)
    if (isInfographicNote(note)) {
      setViewingInfographic(note)
    } else {
      setEditingNote(note)
      setEditorOpen(true)
    }
  }

  const handleDeleteConfirm = async () => {
    if (!noteToDelete) return
    try {
      await deleteNote.mutateAsync(noteToDelete)
      setDeleteDialogOpen(false)
      setNoteToDelete(null)
    } catch (error) {
      console.error('Failed to delete note:', error)
    }
  }

  if (notesCollapsed) {
    return (
      <div className="h-full rounded-2xl bg-[#1c1d20] border border-[#2a2c31] flex flex-col items-center py-3 gap-3">
        <button
          type="button"
          onClick={toggleNotes}
          className="h-8 w-8 rounded-lg flex items-center justify-center text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#282a2f] transition-colors"
          title="Expand Studio"
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setPodcastOpen(true)}
          className="h-8 w-8 rounded-lg flex items-center justify-center text-sky-400 hover:bg-[#282a2f]"
          title="Audio Overview"
        >
          <AudioLines className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={handleGenerateInfographic}
          className="h-8 w-8 rounded-lg flex items-center justify-center text-amber-400 hover:bg-[#282a2f]"
          title="Infographic"
        >
          <BarChart3 className="h-4 w-4" />
        </button>
        <GeneratePodcastDialog open={podcastOpen} onOpenChange={setPodcastOpen} />
      </div>
    )
  }

  return (
    <>
      <div className="h-full flex flex-col rounded-2xl bg-[#1c1d20] border border-[#2a2c31] overflow-hidden">
        {/* Header */}
        <div className="px-4 pt-3.5 pb-3 flex items-center justify-between flex-shrink-0">
          <h2 className="text-[14px] font-medium text-[#e8eaed]">Studio</h2>
          <button
            type="button"
            onClick={toggleNotes}
            className="h-7 w-7 rounded-lg flex items-center justify-center text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#282a2f] transition-colors"
            title="Collapse Studio"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        </div>

        {/* Studio Action Tiles (2-column grid matching NotebookLM — only supported features!) */}
        <div className="px-3.5 pb-3.5 grid grid-cols-2 gap-2 flex-shrink-0">
          {/* 1. Audio Overview (Podcast) */}
          <button
            type="button"
            onClick={() => setPodcastOpen(true)}
            className="h-11 px-3 rounded-xl bg-[#141518] hover:bg-[#25272d] border border-[#2b2d32] flex items-center gap-2.5 text-left transition-colors"
          >
            <AudioLines className="h-4 w-4 text-[#60a5fa] shrink-0" />
            <span className="text-[12.5px] font-medium text-[#e3e5e8] truncate">
              Audio Overview
            </span>
          </button>

          {/* 2. Reports (Transformations + Briefing Docs) */}
          <button
            type="button"
            onClick={() => setReportsDialogOpen(true)}
            disabled={!!generatingReportName}
            className="h-11 px-3 rounded-xl bg-[#141518] hover:bg-[#25272d] border border-[#2b2d32] flex items-center gap-2.5 text-left transition-colors disabled:opacity-60"
          >
            {generatingReportName ? (
              <Loader2 className="h-4 w-4 text-pink-400 animate-spin shrink-0" />
            ) : (
              <FileText className="h-4 w-4 text-pink-400 shrink-0" />
            )}
            <span className="text-[12.5px] font-medium text-[#e3e5e8] truncate">Reports</span>
          </button>

          {/* 3. Infographic (GPT-6.2-Sol HTML/SVG visual) */}
          <button
            type="button"
            onClick={handleGenerateInfographic}
            disabled={isGeneratingInfographic}
            className="h-11 px-3 rounded-xl bg-[#141518] hover:bg-[#25272d] border border-[#2b2d32] flex items-center gap-2.5 text-left transition-colors disabled:opacity-60"
            title="Generate visual infographic with GPT-6.2-Sol"
          >
            {isGeneratingInfographic ? (
              <Loader2 className="h-4 w-4 text-amber-400 animate-spin shrink-0" />
            ) : (
              <BarChart3 className="h-4 w-4 text-amber-400 shrink-0" />
            )}
            <span className="text-[12.5px] font-medium text-[#e3e5e8] truncate">Infographic</span>
          </button>

          {/* 4. Create Note */}
          <button
            type="button"
            onClick={() => {
              setEditingNote(undefined)
              setEditorOpen(true)
            }}
            className="h-11 px-3 rounded-xl bg-[#141518] hover:bg-[#25272d] border border-[#2b2d32] flex items-center gap-2.5 text-left transition-colors"
          >
            <StickyNote className="h-4 w-4 text-emerald-400 shrink-0" />
            <span className="text-[12.5px] font-medium text-[#e3e5e8] truncate">Add note</span>
          </button>
        </div>

        {/* Active Generation Status Banner */}
        {(isGeneratingInfographic || generatingReportName) && (
          <div className="mx-3.5 mb-2.5 px-3 py-2.5 rounded-xl bg-[#16181f] border border-[#323644] flex items-center gap-2.5 text-xs text-[#a8c7fa]">
            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
            <span className="truncate">
              {isGeneratingInfographic
                ? 'Designing infographic with GPT-6.2-Sol...'
                : `Writing ${generatingReportName}...`}
            </span>
          </div>
        )}

        {/* Saved Studio Output & Notes (1-line cards matching screenshot #3) */}
        <div className="flex-1 overflow-y-auto min-h-0 px-2.5 pb-3 border-t border-[#26282e]/70 pt-2.5">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <LoadingSpinner />
            </div>
          ) : (!notes || notes.length === 0) && episodes.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center px-5 py-14 text-[#9aa0a6]">
              <Wand2 className="h-7 w-7 mb-2.5 text-[#8ab4f8]/70" />
              <p className="text-xs font-medium text-[#a8c7fa] mb-1">
                Studio output will be saved here.
              </p>
              <p className="text-[11px] leading-relaxed">
                Click Audio Overview, Reports, Infographic, or pin any chat reply with &ldquo;Save
                to note&rdquo;.
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {/* Saved Notes, Briefing Docs & Infographics */}
              {(notes ?? []).map((note) => {
                const { label, kind } = getNoteKind(note)
                const isUnread = unreadNoteIds.includes(note.id)
                const srcLabel = `${selectedSourcesCount || sources.length || 1} ${
                  (selectedSourcesCount || sources.length || 1) === 1 ? 'source' : 'sources'
                }`
                return (
                  <div
                    key={note.id}
                    onClick={() => handleOpenNoteCard(note)}
                    className="group flex items-center gap-3 px-2.5 py-2.5 rounded-xl hover:bg-[#26282e] transition-colors cursor-pointer"
                  >
                    {/* Left Icon */}
                    <div className="shrink-0">
                      {kind === 'infographic' ? (
                        <BarChart3 className="h-[18px] w-[18px] text-amber-400" />
                      ) : kind === 'report' ? (
                        <FileText className="h-[18px] w-[18px] text-pink-400" />
                      ) : (
                        <Sparkles className="h-[18px] w-[18px] text-pink-400" />
                      )}
                    </div>

                    {/* 1-line Title + Compact Metadata */}
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-[#e8eaed] truncate leading-snug">
                        {note.title || 'Untitled Note'}
                      </p>
                      <p className="text-[11px] text-[#9aa0a6] truncate mt-0.5">
                        {label} · {srcLabel} · {compactRelativeTime(note.updated || note.created)}
                      </p>
                    </div>

                    {/* Blue unread dot (like screenshot #3) or hover actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      {isUnread && (
                        <span
                          className="h-2 w-2 rounded-full bg-[#4c8df6] group-hover:hidden"
                          aria-label="New item"
                        />
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            onClick={(e) => e.stopPropagation()}
                            className="h-7 w-7 rounded-md flex items-center justify-center text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#32343b] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                            aria-label="Note actions"
                          >
                            <MoreVertical className="h-3.5 w-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="bg-[#1c1d20] border-[#2f3136] text-[#e8eaed] w-40"
                        >
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation()
                              setNoteToDelete(note.id)
                              setDeleteDialogOpen(true)
                            }}
                            className="text-red-400 focus:bg-[#282a2f] focus:text-red-400"
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                )
              })}

              {/* Recent Podcast Episodes (Audio Overviews) */}
              {episodes.slice(0, 5).map((ep) => (
                <div
                  key={ep.id}
                  onClick={() => router.push('/podcasts')}
                  className="group flex items-center gap-3 px-2.5 py-2.5 rounded-xl hover:bg-[#26282e] transition-colors cursor-pointer"
                >
                  <AudioLines className="h-[18px] w-[18px] text-[#60a5fa] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium text-[#e8eaed] truncate leading-snug">
                      {ep.name || 'Audio Overview'}
                    </p>
                    <p className="text-[11px] text-[#9aa0a6] truncate mt-0.5">
                      Audio Overview · {ep.job_status || 'ready'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Reports / Transformations Picker Dialog */}
      <Dialog open={reportsDialogOpen} onOpenChange={setReportsDialogOpen}>
        <DialogContent className="sm:max-w-[460px] bg-[#1c1d20] border-[#2f3136] text-[#e8eaed] rounded-2xl p-6">
          <DialogHeader className="pb-3 border-b border-[#2b2d32]">
            <DialogTitle className="text-base font-medium flex items-center gap-2 text-[#e8eaed]">
              <FileText className="h-4 w-4 text-pink-400" />
              Create Report
            </DialogTitle>
            <DialogDescription className="text-xs text-[#9aa0a6]">
              Generate a structured document from your selected sources and save it to Studio.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-2 max-h-[60vh] overflow-y-auto">
            <button
              type="button"
              onClick={() =>
                handleRunReport(
                  'Executive Briefing',
                  'Write an Executive Briefing Doc with: # Executive Briefing title, Overview, Key Themes & Findings, Technical Architecture/Details, and Strategic Takeaways.'
                )
              }
              className="w-full text-left p-3 rounded-xl bg-[#141518] hover:bg-[#25272d] border border-[#2b2d32] transition-colors"
            >
              <p className="text-sm font-medium text-[#e8eaed]">Executive Briefing Doc</p>
              <p className="text-xs text-[#9aa0a6] mt-0.5">
                Concise overview, key findings, and strategic takeaways
              </p>
            </button>

            <button
              type="button"
              onClick={() =>
                handleRunReport(
                  'Study Guide',
                  'Write a comprehensive Study Guide with: # Study Guide title, Core Concepts Glossary, Key Questions & Answers, and Deep-Dive Review Points.'
                )
              }
              className="w-full text-left p-3 rounded-xl bg-[#141518] hover:bg-[#25272d] border border-[#2b2d32] transition-colors"
            >
              <p className="text-sm font-medium text-[#e8eaed]">Study Guide &amp; Q&amp;A</p>
              <p className="text-xs text-[#9aa0a6] mt-0.5">
                Key concepts, review questions, and definitions from your sources
              </p>
            </button>

            {/* Existing Open Notebook Transformations */}
            {transformations.length > 0 && (
              <>
                <p className="text-[11px] font-medium uppercase tracking-wider text-[#9aa0a6] pt-2 px-1">
                  Open Notebook Transformations
                </p>
                {transformations.map((tr) => (
                  <button
                    key={tr.id}
                    type="button"
                    onClick={() => handleRunReport(tr.title || tr.name, tr.prompt)}
                    className="w-full text-left p-3 rounded-xl bg-[#141518] hover:bg-[#25272d] border border-[#2b2d32] transition-colors"
                  >
                    <p className="text-sm font-medium text-[#e8eaed]">{tr.title || tr.name}</p>
                    {tr.description && (
                      <p className="text-xs text-[#9aa0a6] mt-0.5 line-clamp-2">{tr.description}</p>
                    )}
                  </button>
                ))}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <GeneratePodcastDialog open={podcastOpen} onOpenChange={setPodcastOpen} />

      <NoteEditorDialog
        open={editorOpen}
        onOpenChange={(open) => {
          setEditorOpen(open)
          if (!open) setEditingNote(undefined)
        }}
        notebookId={notebookId}
        note={editingNote}
      />

      <InfographicViewerDialog
        open={!!viewingInfographic}
        onOpenChange={(open) => {
          if (!open) setViewingInfographic(null)
        }}
        note={viewingInfographic}
      />

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete note"
        description="Are you sure you want to delete this Studio item? This cannot be undone."
        confirmText="Delete"
        onConfirm={handleDeleteConfirm}
        isLoading={deleteNote.isPending}
        confirmVariant="destructive"
      />
    </>
  )
}
