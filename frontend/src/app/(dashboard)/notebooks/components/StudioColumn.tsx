'use client'

import { useEffect, useRef, useState } from 'react'
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
  Copy,
  Check,
  RotateCcw,
  Play,
  Square,
  ExternalLink,
  AlertCircle,
} from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { formatDistanceToNow } from 'date-fns'
import { NoteEditorDialog } from './NoteEditorDialog'
import {
  InfographicViewerDialog,
  INFOGRAPHIC_MARKER,
  isInfographicNote,
} from '@/components/notebooks/InfographicViewerDialog'
import { GeneratePodcastDialog } from '@/components/podcasts/GeneratePodcastDialog'
import { StudioAudioPlayer } from '@/components/podcasts/StudioAudioPlayer'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { useCreateNote, useDeleteNote } from '@/lib/hooks/use-notes'
import { useTransformations } from '@/lib/hooks/use-transformations'
import {
  usePodcastEpisodes,
  useDeletePodcastEpisode,
  useRetryPodcastEpisode,
} from '@/lib/hooks/use-podcasts'
import { resolvePodcastAssetUrl } from '@/lib/api/podcasts'
import type { PodcastEpisode } from '@/lib/types/podcasts'
import { useNotebookColumnsStore } from '@/lib/stores/notebook-columns-store'
import { useVoiceSettingsStore } from '@/lib/stores/voice-settings-store'
import apiClient from '@/lib/api/client'
import type { ContextSelections } from '../[id]/page'
import { toast } from 'sonner'

const STUDIO_GENERATE_PATH = '/transformations/studio-generate'

// Custom "pencil with 3 dots" icon for one-off prompt customization (Reports & Audio Overview)
function PencilDotsIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4 10.5-10.5z" />
      <circle cx="7" cy="21" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12" cy="21" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="17" cy="21" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  )
}

interface BuiltInReportOption {
  id: string
  title: string
  reportName: string
  description: string
  prompt: string
}

const BUILTIN_REPORTS: BuiltInReportOption[] = [
  {
    id: 'executive-briefing',
    title: 'Executive Briefing Doc',
    reportName: 'Executive Briefing',
    description: 'Concise overview, key findings, and strategic takeaways',
    prompt:
      'Write an Executive Briefing Doc with: # Executive Briefing title, Overview, Key Themes & Findings, Technical Architecture/Details, and Strategic Takeaways.',
  },
  {
    id: 'briefing-doc',
    title: 'Briefing Doc',
    reportName: 'Briefing Doc',
    description:
      'Comprehensive synthesis with executive summary, evidence tables, diagrams, and thorough thematic breakdown',
    prompt:
      'Create a comprehensive briefing document that synthesizes the main themes and ideas from the sources. Start with a concise Executive Summary that presents the most critical takeaways upfront. The body of the document must provide a detailed and thorough examination of the main themes, evidence, and conclusions found in the sources. Include structured Markdown tables for key metrics or metadata, clean ASCII architecture or workflow diagrams (in fenced ```text blocks) where they clarify relationships or hierarchies, exact quotes, commands, or configurations found in the sources, and a complete reference breakdown of major components when applicable. This analysis should be structured logically with clear headings and bullet points to ensure clarity. The tone must be objective and incisive. Ground every claim strictly in the provided sources.',
  },
  {
    id: 'study-guide',
    title: 'Study Guide & Q&A',
    reportName: 'Study Guide',
    description: 'Key concepts, review questions, and definitions from your sources',
    prompt:
      'Write a comprehensive Study Guide with: # Study Guide title, Core Concepts Glossary, Key Questions & Answers, and Deep-Dive Review Points.',
  },
]

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
  const deleteEpisode = useDeletePodcastEpisode()
  const retryEpisode = useRetryPodcastEpisode()
  const { data: transformations = [] } = useTransformations()

  // Pending podcast banner while worker creates the PodcastEpisode row
  const [pendingPodcastName, setPendingPodcastName] = useState<string | null>(null)
  const { episodes = [] } = usePodcastEpisodes({
    autoRefresh: true,
    forcePoll: !!pendingPodcastName,
  })

  // Inline Studio audio player state
  const [playingEpisodeId, setPlayingEpisodeId] = useState<string | null>(null)
  const [playingAudioSrc, setPlayingAudioSrc] = useState<string | null>(null)
  const [loadingAudioId, setLoadingAudioId] = useState<string | null>(null)
  const audioBlobUrlRef = useRef<string | null>(null)

  useEffect(() => {
    if (!pendingPodcastName) return
    const exists = episodes.some(
      (ep) => (ep.name || '').trim().toLowerCase() === pendingPodcastName.trim().toLowerCase()
    )
    if (exists) {
      setPendingPodcastName(null)
    }
  }, [episodes, pendingPodcastName])

  useEffect(() => {
    if (!pendingPodcastName) return
    const timer = setTimeout(() => setPendingPodcastName(null), 45_000)
    return () => clearTimeout(timer)
  }, [pendingPodcastName])

  useEffect(() => {
    return () => {
      if (audioBlobUrlRef.current) {
        URL.revokeObjectURL(audioBlobUrlRef.current)
        audioBlobUrlRef.current = null
      }
    }
  }, [])

  const handleTogglePlayEpisode = async (ep: PodcastEpisode) => {
    if (playingEpisodeId === ep.id) {
      setPlayingEpisodeId(null)
      setPlayingAudioSrc(null)
      if (audioBlobUrlRef.current) {
        URL.revokeObjectURL(audioBlobUrlRef.current)
        audioBlobUrlRef.current = null
      }
      return
    }

    if (!ep.audio_url && !ep.audio_file) {
      toast.info('Audio is still generating — it will be playable as soon as it finishes.')
      return
    }

    setLoadingAudioId(ep.id)
    try {
      const directUrl = await resolvePodcastAssetUrl(ep.audio_url ?? ep.audio_file)
      if (!directUrl) throw new Error('Audio URL unavailable')

      if (audioBlobUrlRef.current) {
        URL.revokeObjectURL(audioBlobUrlRef.current)
        audioBlobUrlRef.current = null
      }

      if (ep.audio_url) {
        const res = await apiClient.get<Blob>(directUrl, { responseType: 'blob' })
        const blobUrl = URL.createObjectURL(res.data)
        audioBlobUrlRef.current = blobUrl
        setPlayingAudioSrc(blobUrl)
      } else {
        setPlayingAudioSrc(directUrl)
      }
      setPlayingEpisodeId(ep.id)
    } catch (err) {
      console.error('Unable to load podcast audio:', err)
      toast.error('Unable to load podcast audio.')
    } finally {
      setLoadingAudioId(null)
    }
  }

  // Dialog states
  const [podcastOpen, setPodcastOpen] = useState(false)
  const [podcastFocusInstructions, setPodcastFocusInstructions] = useState(false)
  const [reportsDialogOpen, setReportsDialogOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingNote, setEditingNote] = useState<NoteResponse | undefined>()
  const [viewingInfographic, setViewingInfographic] = useState<NoteResponse | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [noteToDelete, setNoteToDelete] = useState<string | null>(null)

  // Generation loading states
  const [isGeneratingInfographic, setIsGeneratingInfographic] = useState(false)
  const [generatingReportName, setGeneratingReportName] = useState<string | null>(null)
  const [expandedPromptId, setExpandedPromptId] = useState<string | null>(null)
  const [customPromptDrafts, setCustomPromptDrafts] = useState<Record<string, string>>({})
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null)

  const openPodcastDialog = (focusPrompt = false) => {
    setPodcastFocusInstructions(focusPrompt)
    setPodcastOpen(true)
  }

  const handleReportsDialogOpenChange = (open: boolean) => {
    setReportsDialogOpen(open)
    if (!open) {
      // One-off custom prompts are never persisted once the dialog closes
      setExpandedPromptId(null)
      setCustomPromptDrafts({})
    }
  }

  const handleCopyPrompt = async (id: string, promptText: string) => {
    try {
      await navigator.clipboard.writeText(promptText)
      setCopiedPromptId(id)
      setTimeout(() => setCopiedPromptId(null), 1600)
    } catch {
      toast.error('Failed to copy prompt')
    }
  }

  const selectedSourcesCount = sources.filter(
    (s) => (contextSelections.sources[s.id] ?? 'off') !== 'off'
  ).length

  // Collect checked source IDs (or all notebook sources if none are explicitly toggled on)
  const getSelectedSourceIds = (): string[] => {
    const active = sources
      .filter((s) => (contextSelections.sources[s.id] ?? 'full') !== 'off')
      .map((s) => s.id)
    return active.length > 0 ? active : sources.map((s) => s.id)
  }

  // Generic model-agnostic Studio generator (routes through Open Notebook's configured
  // transformation/large-context model: Codex, Claude Code, Anthropic, Gemini, OpenAI, or Ollama)
  const runStudioGeneration = async (opts: {
    prompt: string
    systemPrompt: string
    maxSourceChars?: number
    focusQuery?: string
  }): Promise<{ output: string; modelName: string }> => {
    try {
      const { data } = await apiClient.post<{
        output?: string
        model_name?: string
      }>(STUDIO_GENERATE_PATH, {
        notebook_id: notebookId,
        source_ids: getSelectedSourceIds(),
        prompt: opts.prompt,
        system_prompt: opts.systemPrompt,
        max_source_chars: opts.maxSourceChars ?? 220000,
        focus_query: opts.focusQuery || undefined,
      })

      const output = String(data?.output || '').trim()
      if (!output) throw new Error('Model returned empty output.')
      return { output, modelName: String(data?.model_name || 'default model') }
    } catch (err: unknown) {
      const axErr = err as {
        response?: { status?: number; data?: { detail?: string } }
        message?: string
      }
      const detail =
        axErr?.response?.data?.detail ||
        (axErr?.response?.status ? `HTTP ${axErr.response.status}` : null) ||
        axErr?.message ||
        'Request failed'
      throw new Error(detail)
    }
  }

  // Generate visual SVG/HTML Infographic via configured Open Notebook model
  const handleGenerateInfographic = async () => {
    if (sources.length === 0) {
      toast.info('Add at least one source first to generate an infographic.')
      return
    }
    if (isGeneratingInfographic) return

    setIsGeneratingInfographic(true)
    toast.info('Generating visual infographic...')

    try {
      const prompt = `Create a stunning, publication-grade, self-contained single-file HTML/CSS/SVG visual infographic summarizing the notebook "${notebookName}" based strictly on the sources below.

Design requirements:
- Dark modern executive infographic theme (deep slate background #0e0f13, elevated cards #181a20, crisp typography using system-ui/Inter, subtle borders #2a2d36, vivid accents in blue #60a5fa, violet #a78bfa, emerald #34d399, amber #fbbf24).
- Include:
  1. Hero header banner with bold title, subtitle, and 3-4 key takeaway stat/metric pills.
  2. Visual architecture / flow diagram using clean inline SVG (arrows, boxes, icons) showing how the core concept works.
  3. Comparison or breakdown cards (e.g. Before vs After, Key Pillars, or Step-by-Step workflow).
  4. Compact bottom "Key Takeaways" strip.
- Must be 100% self-contained (inline CSS + inline SVG, no external CDN dependencies), responsive, and fit cleanly without horizontal overflow.
- Output ONLY raw valid HTML starting with <!DOCTYPE html> and ending with </html>. Do NOT wrap in markdown code fences.`

      const { output, modelName } = await runStudioGeneration({
        prompt,
        systemPrompt:
          'You are an expert information designer who outputs clean, self-contained HTML + inline SVG visual infographics. Output raw HTML only, with no markdown fences or preamble.',
        maxSourceChars: 80000,
      })

      const rawHtml = output
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
      toast.success(`Infographic generated with ${modelName}!`)
    } catch (err: unknown) {
      console.error('Infographic error:', err)
      toast.error(`Infographic failed: ${(err as Error)?.message || 'Check model configuration'}`)
    } finally {
      setIsGeneratingInfographic(false)
    }
  }

  // Generate a Report / Dense Summary / Transformation via configured Open Notebook model
  const handleRunReport = async (
    reportTitle: string,
    instructions: string,
    focusQuery?: string
  ) => {
    if (sources.length === 0) {
      toast.info('Add at least one source first to generate a report.')
      return
    }
    handleReportsDialogOpenChange(false)
    setGeneratingReportName(reportTitle)
    toast.info(`Generating ${reportTitle}...`)

    try {
      const { output: content } = await runStudioGeneration({
        prompt: `${instructions}\n\nNOTEBOOK: ${notebookName}`,
        systemPrompt:
          'You are an expert research analyst. Write clear, thorough, well-structured Markdown grounded strictly in the provided source content. Start with a concise # Title line.',
        maxSourceChars: 220000,
        focusQuery,
      })

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
      toast.error(`Failed to generate report: ${(err as Error)?.message || 'Check model configuration'}`)
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
          onClick={() => openPodcastDialog(false)}
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
        <GeneratePodcastDialog
          open={podcastOpen}
          onOpenChange={setPodcastOpen}
          defaultNotebookId={notebookId}
          focusInstructions={podcastFocusInstructions}
          onPodcastSubmitted={(epName) => setPendingPodcastName(epName)}
        />
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
            onClick={() => openPodcastDialog(false)}
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
        {(isGeneratingInfographic || generatingReportName || pendingPodcastName) && (
          <div className="mx-3.5 mb-2.5 px-3 py-2.5 rounded-xl bg-[#16181f] border border-[#323644] flex items-center gap-2.5 text-xs text-[#a8c7fa]">
            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
            <span className="truncate">
              {isGeneratingInfographic
                ? 'Designing infographic...'
                : generatingReportName
                  ? `Writing ${generatingReportName}...`
                  : `Starting Audio Overview: ${pendingPodcastName}...`}
            </span>
          </div>
        )}

        {/* Saved Studio Output & Notes (1-line cards matching screenshot #3) */}
        <div className="flex-1 overflow-y-auto min-h-0 px-2.5 pb-3 border-t border-[#26282e]/70 pt-2.5">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <LoadingSpinner />
            </div>
          ) : (!notes || notes.length === 0) && episodes.length === 0 && !pendingPodcastName ? (
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
              {/* Podcast Episodes (Audio Overviews) — playable directly inside Studio */}
              {episodes.slice(0, 8).map((ep) => {
                const status: string =
                  ep.job_status || (ep.audio_url || ep.audio_file ? 'completed' : 'unknown')
                const isActive =
                  status === 'running' ||
                  status === 'processing' ||
                  status === 'queued' ||
                  status === 'submitted' ||
                  status === 'pending'
                const isFailed = status === 'failed' || status === 'error'
                const isPlayable = Boolean(ep.audio_url || ep.audio_file) && !isActive && !isFailed
                const isPlaying = playingEpisodeId === ep.id
                const isLoadingAudio = loadingAudioId === ep.id

                return (
                  <div
                    key={ep.id}
                    className={`rounded-xl transition-colors ${
                      isPlaying ? 'bg-[#22242b] border border-[#343844]' : 'hover:bg-[#26282e]'
                    }`}
                  >
                    <div
                      onClick={() => {
                        if (isPlayable) {
                          void handleTogglePlayEpisode(ep)
                        } else if (!isActive) {
                          router.push('/podcasts')
                        }
                      }}
                      className="group flex items-center gap-3 px-2.5 py-2.5 cursor-pointer"
                    >
                      <div className="shrink-0">
                        {isActive || isLoadingAudio ? (
                          <Loader2 className="h-[18px] w-[18px] text-[#60a5fa] animate-spin" />
                        ) : isFailed ? (
                          <AlertCircle className="h-[18px] w-[18px] text-red-400" />
                        ) : (
                          <AudioLines className="h-[18px] w-[18px] text-[#60a5fa]" />
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium text-[#e8eaed] truncate leading-snug">
                          {ep.name || 'Audio Overview'}
                        </p>
                        <p className="text-[11px] text-[#9aa0a6] truncate mt-0.5">
                          {isActive
                            ? 'Audio Overview · Generating...'
                            : isFailed
                              ? 'Audio Overview · Failed'
                              : `Audio Overview · ${ep.created ? compactRelativeTime(ep.created) : 'Ready'}`}
                        </p>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {isPlayable && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleTogglePlayEpisode(ep)
                            }}
                            title={isPlaying ? 'Close player' : 'Play Audio Overview'}
                            aria-label={isPlaying ? 'Close player' : 'Play Audio Overview'}
                            className={`h-7 w-7 rounded-full flex items-center justify-center transition-colors ${
                              isPlaying
                                ? 'bg-[#8ab4f8] text-[#0f1115]'
                                : 'bg-[#25272d] text-[#e8eaed] hover:bg-[#32353e]'
                            }`}
                          >
                            {isPlaying ? (
                              <Square className="h-3 w-3 fill-current" />
                            ) : (
                              <Play className="h-3.5 w-3.5 fill-current ml-0.5" />
                            )}
                          </button>
                        )}

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              onClick={(e) => e.stopPropagation()}
                              className="h-7 w-7 rounded-md flex items-center justify-center text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#32343b] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                              aria-label="Podcast actions"
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
                                router.push('/podcasts')
                              }}
                              className="focus:bg-[#282a2f]"
                            >
                              <ExternalLink className="h-3.5 w-3.5 mr-2" /> Open in Podcasts
                            </DropdownMenuItem>
                            {isFailed && (
                              <DropdownMenuItem
                                onClick={(e) => {
                                  e.stopPropagation()
                                  retryEpisode.mutate(ep.id)
                                }}
                                className="focus:bg-[#282a2f]"
                              >
                                <RotateCcw className="h-3.5 w-3.5 mr-2" /> Retry
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation()
                                if (playingEpisodeId === ep.id) {
                                  setPlayingEpisodeId(null)
                                  setPlayingAudioSrc(null)
                                }
                                deleteEpisode.mutate(ep.id)
                              }}
                              className="text-red-400 focus:bg-[#282a2f] focus:text-red-400"
                            >
                              <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>

                    {isPlaying && playingAudioSrc && (
                      <div className="px-2.5 pb-2.5 pt-0.5">
                        <StudioAudioPlayer
                          src={playingAudioSrc}
                          autoPlay
                          downloadFilename={`${(ep.name || 'audio-overview').replace(/[^a-z0-9-_]+/gi, '_')}.mp3`}
                        />
                      </div>
                    )}
                  </div>
                )
              })}

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
            </div>
          )}
        </div>
      </div>

      {/* Reports / Transformations Picker Dialog */}
      <Dialog open={reportsDialogOpen} onOpenChange={handleReportsDialogOpenChange}>
        <DialogContent className="sm:max-w-[520px] bg-[#1c1d20] border-[#2f3136] text-[#e8eaed] rounded-2xl p-6">
          <DialogHeader className="pb-3 border-b border-[#2b2d32]">
            <DialogTitle className="text-base font-medium flex items-center gap-2 text-[#e8eaed]">
              <FileText className="h-4 w-4 text-pink-400" />
              Create Report
            </DialogTitle>
            <DialogDescription className="text-xs text-[#9aa0a6]">
              Click a report to generate immediately, or click the customize icon to tweak its prompt for this run only.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-2 max-h-[65vh] overflow-y-auto pr-1">
            {BUILTIN_REPORTS.map((rep) => {
              const isPromptOpen = expandedPromptId === rep.id
              const draft = customPromptDrafts[rep.id] ?? rep.prompt
              const isModified = draft.trim() !== rep.prompt.trim()
              return (
                <div
                  key={rep.id}
                  className="rounded-xl bg-[#141518] border border-[#2b2d32] overflow-hidden transition-colors hover:border-[#3c3f47]"
                >
                  <div className="flex items-start gap-2 p-3">
                    <button
                      type="button"
                      onClick={() =>
                        handleRunReport(
                          rep.reportName,
                          draft.trim() || rep.prompt,
                          isModified ? draft.trim() : undefined
                        )
                      }
                      className="flex-1 text-left min-w-0 hover:opacity-90"
                    >
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-[#e8eaed]">{rep.title}</p>
                        {isModified && (
                          <span className="rounded bg-[#213352] px-1.5 py-0.5 text-[10px] font-medium text-[#8ab4f8]">
                            Customized
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-[#9aa0a6] mt-0.5">{rep.description}</p>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setExpandedPromptId((prev) => (prev === rep.id ? null : rep.id))
                        setCustomPromptDrafts((prev) =>
                          rep.id in prev ? prev : { ...prev, [rep.id]: rep.prompt }
                        )
                      }}
                      title="Edit prompt for this report only"
                      aria-label={`Edit prompt for ${rep.title}`}
                      className={`shrink-0 h-7 px-2 rounded-md text-[11px] flex items-center gap-1 transition-colors ${
                        isPromptOpen || isModified
                          ? 'bg-[#25272d] text-[#8ab4f8]'
                          : 'text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#25272d]'
                      }`}
                    >
                      <PencilDotsIcon className="h-3.5 w-3.5" />
                      <span>Prompt</span>
                    </button>
                  </div>

                  {isPromptOpen && (
                    <div className="border-t border-[#26282e] bg-[#101114] px-3 py-3 space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium text-[#9aa0a6] flex items-center gap-1.5">
                          <Sparkles className="h-3 w-3 text-[#8ab4f8]" />
                          One-off prompt <span className="text-[#6f747d] font-normal">(not saved)</span>
                        </span>
                        <div className="flex items-center gap-2">
                          {isModified && (
                            <button
                              type="button"
                              onClick={() =>
                                setCustomPromptDrafts((prev) => ({ ...prev, [rep.id]: rep.prompt }))
                              }
                              className="text-[11px] text-[#9aa0a6] hover:text-[#e8eaed] flex items-center gap-1"
                            >
                              <RotateCcw className="h-3 w-3" />
                              Reset
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleCopyPrompt(rep.id, draft)}
                            className="text-[11px] text-[#9aa0a6] hover:text-[#e8eaed] flex items-center gap-1"
                          >
                            {copiedPromptId === rep.id ? (
                              <>
                                <Check className="h-3 w-3 text-emerald-400" />
                                Copied
                              </>
                            ) : (
                              <>
                                <Copy className="h-3 w-3" />
                                Copy
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                      <Textarea
                        value={draft}
                        onChange={(e) =>
                          setCustomPromptDrafts((prev) => ({
                            ...prev,
                            [rep.id]: e.target.value,
                          }))
                        }
                        rows={5}
                        placeholder="Edit instructions or add a specific focus (e.g., Focus only on the steps to implement this methodology)..."
                        className="bg-[#18191d] border-[#2e3037] text-xs leading-relaxed text-[#e3e5e8] focus-visible:ring-[#8ab4f8]/50"
                      />
                      <div className="flex justify-end">
                        <button
                          type="button"
                          disabled={!draft.trim() || !!generatingReportName}
                          onClick={() =>
                            handleRunReport(
                              rep.reportName,
                              draft.trim(),
                              isModified ? draft.trim() : undefined
                            )
                          }
                          className="h-7 px-3 rounded-lg bg-[#8ab4f8] hover:bg-[#a6c8ff] text-[#0f1115] text-xs font-medium transition-colors disabled:opacity-50"
                        >
                          Generate {rep.title}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}

            {/* Existing Open Notebook Transformations */}
            {transformations.length > 0 && (
              <>
                <p className="text-[11px] font-medium uppercase tracking-wider text-[#9aa0a6] pt-2 px-1">
                  Open Notebook Transformations
                </p>
                {transformations.map((tr) => {
                  const isPromptOpen = expandedPromptId === tr.id
                  const basePrompt = tr.prompt || ''
                  const draft = customPromptDrafts[tr.id] ?? basePrompt
                  const isModified = draft.trim() !== basePrompt.trim()
                  return (
                    <div
                      key={tr.id}
                      className="rounded-xl bg-[#141518] border border-[#2b2d32] overflow-hidden transition-colors hover:border-[#3c3f47]"
                    >
                      <div className="flex items-start gap-2 p-3">
                        <button
                          type="button"
                          onClick={() =>
                            handleRunReport(
                              tr.title || tr.name,
                              draft.trim() || basePrompt,
                              isModified ? draft.trim() : undefined
                            )
                          }
                          className="flex-1 text-left min-w-0 hover:opacity-90"
                        >
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-[#e8eaed]">
                              {tr.title || tr.name}
                            </p>
                            {isModified && (
                              <span className="rounded bg-[#213352] px-1.5 py-0.5 text-[10px] font-medium text-[#8ab4f8]">
                                Customized
                              </span>
                            )}
                          </div>
                          {tr.description && (
                            <p className="text-xs text-[#9aa0a6] mt-0.5 line-clamp-2">
                              {tr.description}
                            </p>
                          )}
                        </button>
                        {basePrompt && (
                          <button
                            type="button"
                            onClick={() => {
                              setExpandedPromptId((prev) => (prev === tr.id ? null : tr.id))
                              setCustomPromptDrafts((prev) =>
                                tr.id in prev ? prev : { ...prev, [tr.id]: basePrompt }
                              )
                            }}
                            title="Edit prompt for this report only"
                            aria-label={`Edit prompt for ${tr.title || tr.name}`}
                            className={`shrink-0 h-7 px-2 rounded-md text-[11px] flex items-center gap-1 transition-colors ${
                              isPromptOpen || isModified
                                ? 'bg-[#25272d] text-[#8ab4f8]'
                                : 'text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#25272d]'
                            }`}
                          >
                            <PencilDotsIcon className="h-3.5 w-3.5" />
                            <span>Prompt</span>
                          </button>
                        )}
                      </div>
                      {isPromptOpen && basePrompt && (
                        <div className="border-t border-[#26282e] bg-[#101114] px-3 py-3 space-y-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-medium text-[#9aa0a6] flex items-center gap-1.5">
                              <Sparkles className="h-3 w-3 text-[#8ab4f8]" />
                              One-off prompt{' '}
                              <span className="text-[#6f747d] font-normal">(not saved)</span>
                            </span>
                            <div className="flex items-center gap-2">
                              {isModified && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setCustomPromptDrafts((prev) => ({
                                      ...prev,
                                      [tr.id]: basePrompt,
                                    }))
                                  }
                                  className="text-[11px] text-[#9aa0a6] hover:text-[#e8eaed] flex items-center gap-1"
                                >
                                  <RotateCcw className="h-3 w-3" />
                                  Reset
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => handleCopyPrompt(tr.id, draft)}
                                className="text-[11px] text-[#9aa0a6] hover:text-[#e8eaed] flex items-center gap-1"
                              >
                                {copiedPromptId === tr.id ? (
                                  <>
                                    <Check className="h-3 w-3 text-emerald-400" />
                                    Copied
                                  </>
                                ) : (
                                  <>
                                    <Copy className="h-3 w-3" />
                                    Copy
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                          <Textarea
                            value={draft}
                            onChange={(e) =>
                              setCustomPromptDrafts((prev) => ({
                                ...prev,
                                [tr.id]: e.target.value,
                              }))
                            }
                            rows={5}
                            placeholder="Edit instructions or add a specific focus for this run only..."
                            className="bg-[#18191d] border-[#2e3037] text-xs leading-relaxed text-[#e3e5e8] focus-visible:ring-[#8ab4f8]/50"
                          />
                          <div className="flex justify-end">
                            <button
                              type="button"
                              disabled={!draft.trim() || !!generatingReportName}
                              onClick={() =>
                                handleRunReport(
                                  tr.title || tr.name,
                                  draft.trim(),
                                  isModified ? draft.trim() : undefined
                                )
                              }
                              className="h-7 px-3 rounded-lg bg-[#8ab4f8] hover:bg-[#a6c8ff] text-[#0f1115] text-xs font-medium transition-colors disabled:opacity-50"
                            >
                              Generate {tr.title || tr.name}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <GeneratePodcastDialog
        open={podcastOpen}
        onOpenChange={setPodcastOpen}
        defaultNotebookId={notebookId}
        focusInstructions={podcastFocusInstructions}
        onPodcastSubmitted={(epName) => setPendingPodcastName(epName)}
      />

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
