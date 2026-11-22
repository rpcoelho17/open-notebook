'use client'

import { useMemo, useState } from 'react'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FolderGit2,
  Search,
} from 'lucide-react'

export const GITHUB_INDEXED_FILES_MARKER = '<!-- GITHUB_INDEXED_FILES_START -->'

interface ParsedGitHubFile {
  path: string
  lineCount: number | null
  markdown: string
}

interface ParsedGitHubSource {
  summaryMarkdown: string
  files: ParsedGitHubFile[]
}

export function isGitHubStructuredSource(fullText?: string | null): boolean {
  return !!fullText && fullText.includes(GITHUB_INDEXED_FILES_MARKER)
}

function parseGitHubStructuredSource(fullText: string): ParsedGitHubSource {
  const markerIdx = fullText.indexOf(GITHUB_INDEXED_FILES_MARKER)
  if (markerIdx === -1) {
    return { summaryMarkdown: fullText, files: [] }
  }

  // Strip trailing horizontal rule right before the marker
  const summaryMarkdown = fullText
    .slice(0, markerIdx)
    .replace(/\n+---\s*$/, '')
    .trim()

  const filesSection = fullText.slice(markerIdx + GITHUB_INDEXED_FILES_MARKER.length)
  const files: ParsedGitHubFile[] = []

  const fileRegex =
    /<!--\s*GITHUB_FILE_START:\s*(.+?)\s*-->\s*([\s\S]*?)<!--\s*GITHUB_FILE_END\s*-->/g
  let match: RegExpExecArray | null
  while ((match = fileRegex.exec(filesSection)) !== null) {
    const path = match[1].trim()
    const rawBody = match[2].trim()
    const headerMatch = rawBody.match(/^###\s+File:[^\n]*\((\d+)\s+lines?\)\s*\n+/)
    const lineCount = headerMatch ? parseInt(headerMatch[1], 10) : null
    const markdown = headerMatch ? rawBody.slice(headerMatch[0].length).trim() : rawBody
    files.push({ path, lineCount, markdown })
  }

  return { summaryMarkdown, files }
}

interface GitHubSourceContentProps {
  fullText: string
}

export function GitHubSourceContent({ fullText }: GitHubSourceContentProps) {
  const { summaryMarkdown, files } = useMemo(
    () => parseGitHubStructuredSource(fullText),
    [fullText]
  )

  const [filesSectionOpen, setFilesSectionOpen] = useState(false)
  const [filterQuery, setFilterQuery] = useState('')
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({})

  const filteredFiles = useMemo(() => {
    const q = filterQuery.trim().toLowerCase()
    if (!q) return files
    return files.filter((f) => f.path.toLowerCase().includes(q))
  }, [files, filterQuery])

  const toggleFile = (path: string) => {
    setExpandedFiles((prev) => ({ ...prev, [path]: !prev[path] }))
  }

  return (
    <div className="space-y-6">
      <MarkdownRenderer>{summaryMarkdown}</MarkdownRenderer>

      {files.length > 0 && (
        <div className="rounded-lg border border-border bg-card/40 overflow-hidden">
          <button
            type="button"
            onClick={() => setFilesSectionOpen((prev) => !prev)}
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-accent/40 transition-colors"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              {filesSectionOpen ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              )}
              <FolderGit2 className="h-4 w-4 text-purple-400 shrink-0" />
              <span className="text-sm font-medium">
                Indexed Source Files
              </span>
              <Badge variant="secondary" className="font-mono text-xs">
                {files.length}
              </Badge>
            </div>
            <span className="text-xs text-muted-foreground shrink-0">
              {filesSectionOpen ? 'Hide files' : 'Browse & expand code'}
            </span>
          </button>

          {filesSectionOpen && (
            <div className="border-t border-border p-3 space-y-2.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                  placeholder={`Filter ${files.length} indexed files by path...`}
                  className="h-8 pl-8 font-mono text-xs"
                />
              </div>

              {filteredFiles.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  No indexed files match &ldquo;{filterQuery}&rdquo;
                </p>
              ) : (
                <div className="divide-y divide-border/60 rounded-md border border-border/70 overflow-hidden">
                  {filteredFiles.map((file) => {
                    const isOpen = !!expandedFiles[file.path]
                    return (
                      <div key={file.path} className="bg-background/40">
                        <button
                          type="button"
                          onClick={() => toggleFile(file.path)}
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-accent/40 transition-colors"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            {isOpen ? (
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            )}
                            <FileCode2 className="h-3.5 w-3.5 text-purple-400/80 shrink-0" />
                            <span className="truncate font-mono text-xs text-foreground">
                              {file.path}
                            </span>
                          </div>
                          {file.lineCount !== null && (
                            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                              {file.lineCount} lines
                            </span>
                          )}
                        </button>
                        {isOpen && (
                          <div className="border-t border-border/60 px-3 py-2.5 overflow-x-auto bg-background/70">
                            <MarkdownRenderer>{file.markdown}</MarkdownRenderer>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
