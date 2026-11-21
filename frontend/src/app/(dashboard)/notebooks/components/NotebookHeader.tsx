'use client'

import { useState } from 'react'
import Link from 'next/link'
import { NotebookResponse } from '@/lib/types/api'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Plus,
  Settings,
  MoreVertical,
  Archive,
  ArchiveRestore,
  Trash2,
  LayoutGrid,
  BookOpen,
  Podcast,
  Cpu,
  Sliders,
  Sparkles,
} from 'lucide-react'
import { useUpdateNotebook } from '@/lib/hooks/use-notebooks'
import { NotebookDeleteDialog } from './NotebookDeleteDialog'
import { CreateNotebookDialog } from '@/components/notebooks/CreateNotebookDialog'
import { InlineEdit } from '@/components/common/InlineEdit'
import { useTranslation } from '@/lib/hooks/use-translation'

interface NotebookHeaderProps {
  notebook: NotebookResponse
  onOpenSettings?: () => void
}

export function NotebookHeader({ notebook, onOpenSettings }: NotebookHeaderProps) {
  const { t } = useTranslation()
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)

  const updateNotebook = useUpdateNotebook()

  const handleUpdateName = async (name: string) => {
    if (!name || name === notebook.name) return
    await updateNotebook.mutateAsync({
      id: notebook.id,
      data: { name },
    })
  }

  const handleArchiveToggle = () => {
    updateNotebook.mutate({
      id: notebook.id,
      data: { archived: !notebook.archived },
    })
  }

  return (
    <>
      <header className="h-14 px-4 bg-[#0e0f12] flex items-center justify-between gap-4 flex-shrink-0 select-none">
        {/* Left: NotebookLM-style arch logo + editable title */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Link
            href="/notebooks"
            title="All Notebooks"
            className="h-8 w-8 rounded-full flex items-center justify-center hover:bg-[#1e1f22] transition-colors shrink-0"
          >
            <svg viewBox="0 0 28 28" className="h-6 w-6" fill="none">
              <path
                d="M4 19C4 12.925 8.477 8 14 8C19.523 8 24 12.925 24 19"
                stroke="#8ab4f8"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
              <path
                d="M8.2 19C8.2 15.2 10.797 12.1 14 12.1C17.203 12.1 19.8 15.2 19.8 19"
                stroke="#c58af9"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
              <path
                d="M12.2 19C12.2 17.5 13 16.4 14 16.4C15 16.4 15.8 17.5 15.8 19"
                stroke="#e8eaed"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
            </svg>
          </Link>

          <div className="min-w-0 flex-1 max-w-[560px]">
            <InlineEdit
              id="notebook-name"
              name="notebook-name"
              value={notebook.name}
              onSave={handleUpdateName}
              className="text-[17px] font-medium text-[#e8eaed] tracking-tight truncate block text-left hover:bg-[#1e1f22] px-2 py-1 rounded-lg transition-colors"
              inputClassName="text-[17px] font-medium text-[#e8eaed] bg-[#1e1f22] border-[#3c4043] px-2 py-0.5 rounded-lg"
              placeholder={t('notebooks.namePlaceholder')}
            />
          </div>
        </div>

        {/* Right: + Create notebook, menu, Settings gear, App switcher, Avatar */}
        <div className="flex items-center gap-2 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowCreateDialog(true)}
            className="h-8 px-3.5 rounded-full bg-[#1c1d20] hover:bg-[#282a2f] border border-[#2f3136] text-[#e8eaed] text-xs font-medium gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            Create notebook
          </Button>

          {/* Notebook Actions Menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="h-8 w-8 rounded-full flex items-center justify-center text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#1e1f22] transition-colors"
                title="Notebook options"
              >
                <MoreVertical className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="bg-[#1c1d20] border-[#2f3136] text-[#e8eaed] w-48"
            >
              <DropdownMenuItem
                onClick={handleArchiveToggle}
                className="focus:bg-[#282a2f] focus:text-[#e8eaed]"
              >
                {notebook.archived ? (
                  <>
                    <ArchiveRestore className="h-4 w-4 mr-2" />
                    {t('notebooks.unarchive')}
                  </>
                ) : (
                  <>
                    <Archive className="h-4 w-4 mr-2" />
                    {t('notebooks.archive')}
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-[#2b2d32]" />
              <DropdownMenuItem
                onClick={() => setShowDeleteDialog(true)}
                className="text-red-400 focus:bg-[#282a2f] focus:text-red-400"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Top-right Settings Gear (Voice + Studio defaults) */}
          <button
            type="button"
            onClick={onOpenSettings}
            className="h-8 w-8 rounded-full flex items-center justify-center text-[#c4c7c5] hover:text-[#e8eaed] hover:bg-[#1e1f22] transition-colors"
            title="Voice & Studio Settings"
            aria-label="Voice & Studio Settings"
          >
            <Settings className="h-[18px] w-[18px]" />
          </button>

          {/* App Navigation Switcher (9-dot grid like NotebookLM) */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="h-8 w-8 rounded-full flex items-center justify-center text-[#c4c7c5] hover:text-[#e8eaed] hover:bg-[#1e1f22] transition-colors"
                title="Open Notebook Navigation"
              >
                <LayoutGrid className="h-[18px] w-[18px]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="bg-[#1c1d20] border-[#2f3136] text-[#e8eaed] w-52"
            >
              <DropdownMenuItem asChild className="focus:bg-[#282a2f] focus:text-[#e8eaed]">
                <Link href="/notebooks">
                  <BookOpen className="h-4 w-4 mr-2 text-[#8ab4f8]" /> All Notebooks
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild className="focus:bg-[#282a2f] focus:text-[#e8eaed]">
                <Link href="/podcasts">
                  <Podcast className="h-4 w-4 mr-2 text-sky-400" /> Podcasts
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild className="focus:bg-[#282a2f] focus:text-[#e8eaed]">
                <Link href="/transformations">
                  <Sparkles className="h-4 w-4 mr-2 text-pink-400" /> Transformations
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-[#2b2d32]" />
              <DropdownMenuItem asChild className="focus:bg-[#282a2f] focus:text-[#e8eaed]">
                <Link href="/settings/models">
                  <Cpu className="h-4 w-4 mr-2 text-amber-400" /> Models & Providers
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild className="focus:bg-[#282a2f] focus:text-[#e8eaed]">
                <Link href="/settings">
                  <Sliders className="h-4 w-4 mr-2 text-emerald-400" /> App Settings
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* User Avatar Pill */}
          <Link
            href="/notebooks"
            title="Home"
            className="h-8 w-8 rounded-full bg-[#1a4d6e] border-2 border-[#4285f4]/70 text-[#e8eaed] text-xs font-semibold flex items-center justify-center shrink-0 hover:opacity-90 transition-opacity"
          >
            R
          </Link>
        </div>
      </header>

      <CreateNotebookDialog open={showCreateDialog} onOpenChange={setShowCreateDialog} />

      <NotebookDeleteDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        notebookId={notebook.id}
        notebookName={notebook.name}
        redirectAfterDelete
      />
    </>
  )
}
