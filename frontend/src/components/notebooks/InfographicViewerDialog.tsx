'use client'

import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Download, ExternalLink, BarChart3 } from 'lucide-react'
import { NoteResponse } from '@/lib/types/api'

export const INFOGRAPHIC_MARKER = '<!-- OPEN_NOTEBOOK_INFOGRAPHIC_HTML -->'

export function isInfographicNote(note?: NoteResponse | null): boolean {
  if (!note?.content) return false
  return note.content.includes(INFOGRAPHIC_MARKER)
}

export function extractInfographicHtml(content: string): string {
  const idx = content.indexOf(INFOGRAPHIC_MARKER)
  if (idx === -1) return content
  return content.slice(idx + INFOGRAPHIC_MARKER.length).trim()
}

interface InfographicViewerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  note: NoteResponse | null
}

export function InfographicViewerDialog({
  open,
  onOpenChange,
  note,
}: InfographicViewerDialogProps) {
  if (!note) return null
  const html = extractInfographicHtml(note.content || '')

  const handleDownloadHtml = () => {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(note.title || 'infographic').replace(/[^a-z0-9-_]+/gi, '_')}.html`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleOpenNewTab = () => {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[92vw] sm:max-w-[1060px] h-[88vh] flex flex-col p-0 overflow-hidden bg-[#131417] border-[#2f3136] text-[#e8eaed] rounded-2xl">
        <DialogHeader className="px-5 py-3.5 border-b border-[#2a2c31] flex flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-2.5 min-w-0 pr-8">
            <div className="h-7 w-7 rounded-lg bg-amber-500/15 text-amber-400 flex items-center justify-center shrink-0">
              <BarChart3 className="h-4 w-4" />
            </div>
            <DialogTitle className="text-sm font-medium truncate text-[#e8eaed]">
              {note.title || 'Infographic'}
            </DialogTitle>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#25262b] text-[#9aa0a6] shrink-0">
              gpt-6.2-sol
            </span>
          </div>
          <div className="flex items-center gap-2 pr-6">
            <Button
              size="sm"
              variant="outline"
              onClick={handleOpenNewTab}
              className="h-8 text-xs bg-[#1c1d20] border-[#32343a] text-[#e8eaed] hover:bg-[#2a2c31] rounded-full gap-1.5"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Open Full
            </Button>
            <Button
              size="sm"
              onClick={handleDownloadHtml}
              className="h-8 text-xs bg-[#8ab4f8] text-[#0e0f12] hover:bg-[#a8c7fa] rounded-full gap-1.5"
            >
              <Download className="h-3.5 w-3.5" /> Download
            </Button>
          </div>
        </DialogHeader>

        <div className="flex-1 bg-[#0b0c0e] overflow-hidden">
          <iframe
            title={note.title || 'Infographic'}
            srcDoc={html}
            sandbox="allow-scripts"
            className="w-full h-full border-0"
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
