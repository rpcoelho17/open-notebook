'use client'

import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  useVoiceSettingsStore,
  VOICE_ENGINE_OPTIONS,
  GEMINI_SEND_MODE_OPTIONS,
  GEMINI_LIVE_VOICES,
  KOKORO_VOICES,
  VOICE_LLM_OPTIONS,
  REASONING_EFFORT_OPTIONS,
} from '@/lib/stores/voice-settings-store'
import {
  useModels,
  useModelDefaults,
  useUpdateModelDefaults,
} from '@/lib/hooks/use-models'
import { Settings2, Cpu, Volume2, Sparkles, ExternalLink, Check, Bot, AudioLines } from 'lucide-react'

interface NotebookSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function NotebookSettingsDialog({ open, onOpenChange }: NotebookSettingsDialogProps) {
  const {
    engine,
    geminiSendMode,
    voiceModel,
    reasoningEffort,
    geminiVoice,
    kokoroVoice,
    setEngine,
    setGeminiSendMode,
    setVoiceModel,
    setReasoningEffort,
    setGeminiVoice,
    setKokoroVoice,
  } = useVoiceSettingsStore()

  const { data: allModels = [] } = useModels()
  const { data: modelDefaults } = useModelDefaults()
  const updateModelDefaults = useUpdateModelDefaults()

  const [geminiConfigured, setGeminiConfigured] = useState<boolean | null>(null)

  useEffect(() => {
    if (!open) return
    fetch('/api/gemini-live/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && typeof data.configured === 'boolean') {
          setGeminiConfigured(data.configured)
        }
      })
      .catch(() => setGeminiConfigured(null))
  }, [open])

  const chatModels = allModels.filter((m) => m.type === 'language')
  const activeChatModelId = modelDefaults?.default_chat_model || ''
  const activeChatModelName =
    chatModels.find((m) => m.id === activeChatModelId)?.name || 'gpt-6-luna'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] max-h-[88vh] overflow-y-auto bg-[#1c1d20] border-[#2f3136] text-[#e8eaed] rounded-2xl p-6">
        <DialogHeader className="pb-3 border-b border-[#2b2d32]">
          <DialogTitle className="text-base font-medium flex items-center gap-2 text-[#e8eaed]">
            <Settings2 className="h-4 w-4 text-[#8ab4f8]" />
            Voice, Chat Model &amp; Studio Settings
          </DialogTitle>
          <DialogDescription className="text-xs text-[#9aa0a6]">
            Pick your speech-to-speech engine below. Clicking the Voice button in chat uses your selected option immediately.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Speech-to-Speech Option Group (2 simple options) */}
          <div className="space-y-2">
            <Label className="text-xs font-medium text-[#9aa0a6] uppercase tracking-wider flex items-center gap-1.5">
              <AudioLines className="h-3.5 w-3.5" /> Speech-to-Speech Engine
            </Label>
            <div role="radiogroup" aria-label="Speech-to-Speech Engine" className="space-y-2">
              {VOICE_ENGINE_OPTIONS.map((item) => {
                const selected = engine === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setEngine(item.id)}
                    className={`w-full text-left p-3 rounded-xl border transition-all flex items-start justify-between gap-3 ${
                      selected
                        ? 'bg-[#252830] border-[#8ab4f8]/60 ring-1 ring-[#8ab4f8]/30'
                        : 'bg-[#141518] border-[#2b2d32] hover:bg-[#22242a]'
                    }`}
                  >
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[#e8eaed]">{item.title}</span>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#2a2c33] text-[#a8c7fa]">
                          {item.badge}
                        </span>
                      </div>
                      <p className="text-xs text-[#9aa0a6] leading-relaxed">{item.subtitle}</p>
                    </div>
                    <div
                      className={`mt-0.5 h-4 w-4 rounded-full border flex items-center justify-center shrink-0 ${
                        selected
                          ? 'bg-[#8ab4f8] border-[#8ab4f8] text-[#0e0f12]'
                          : 'border-[#5f6368]'
                      }`}
                    >
                      {selected && <Check className="h-2.5 w-2.5 stroke-[3]" />}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Voice Picker for the selected engine */}
          {engine === 'gemini-live' ? (
            <div className="space-y-4">
              {/* Gemini Live Send Mode: Press ↑ to send (default) vs Hands-free */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-[#9aa0a6] uppercase tracking-wider flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5" /> Gemini Live Input Mode
                </Label>
                <div
                  role="radiogroup"
                  aria-label="Gemini Live Input Mode"
                  className="grid grid-cols-2 gap-2"
                >
                  {GEMINI_SEND_MODE_OPTIONS.map((opt) => {
                    const active = geminiSendMode === opt.id
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setGeminiSendMode(opt.id)}
                        className={`text-left p-2.5 rounded-xl border transition-all ${
                          active
                            ? 'bg-[#252830] border-[#8ab4f8]/60 ring-1 ring-[#8ab4f8]/30'
                            : 'bg-[#141518] border-[#2b2d32] hover:bg-[#22242a]'
                        }`}
                      >
                        <div className="text-xs font-medium text-[#e8eaed]">{opt.label}</div>
                        <div className="text-[11px] text-[#9aa0a6] mt-0.5 leading-snug">
                          {opt.description}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="space-y-2.5">
                <Label className="text-xs font-medium text-[#9aa0a6] uppercase tracking-wider flex items-center gap-1.5">
                  <Volume2 className="h-3.5 w-3.5" /> Gemini Live Voice
                </Label>
                <div className="flex flex-wrap gap-2">
                  {GEMINI_LIVE_VOICES.map((v) => {
                    const active = geminiVoice === v.id
                    return (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => setGeminiVoice(v.id)}
                        className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${
                          active
                            ? 'bg-[#8ab4f8] text-[#0e0f12] font-medium border-[#8ab4f8]'
                            : 'bg-[#141518] text-[#c4c7c5] border-[#2f3136] hover:bg-[#25262b]'
                        }`}
                      >
                        {v.label}
                      </button>
                    )
                  })}
                </div>
                {geminiConfigured !== null && (
                  <p className="text-[11px] text-[#9aa0a6]">
                    {geminiConfigured
                      ? '✓ Gemini API key loaded from server .env (Gemini Live Native Audio ready)'
                      : '⚠ Add GOOGLE_GEMINI_API or GEMINI_API_KEY to .env to use Gemini Live'}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-xs font-medium text-[#9aa0a6] uppercase tracking-wider flex items-center gap-1.5">
                  <Volume2 className="h-3.5 w-3.5" /> Local Kokoro-82M Voice
                </Label>
                <div className="flex flex-wrap gap-2">
                  {KOKORO_VOICES.map((v) => {
                    const active = kokoroVoice === v.id
                    return (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => setKokoroVoice(v.id)}
                        className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${
                          active
                            ? 'bg-[#8ab4f8] text-[#0e0f12] font-medium border-[#8ab4f8]'
                            : 'bg-[#141518] text-[#c4c7c5] border-[#2f3136] hover:bg-[#25262b]'
                        }`}
                      >
                        {v.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs font-medium text-[#9aa0a6] uppercase tracking-wider flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5" /> Local Voice Chat Model (Streaming)
                </Label>
                <div className="flex flex-wrap gap-2">
                  {VOICE_LLM_OPTIONS.map((opt) => {
                    const active = voiceModel === opt.id
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setVoiceModel(opt.id)}
                        className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${
                          active
                            ? 'bg-[#8ab4f8] text-[#0e0f12] font-medium border-[#8ab4f8]'
                            : 'bg-[#141518] text-[#c4c7c5] border-[#2f3136] hover:bg-[#25262b]'
                        }`}
                      >
                        {opt.id === 'match-chat' ? `Match Chat (${activeChatModelName})` : opt.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Chat Model Quick Switcher */}
          {chatModels.length > 0 && (
            <div className="space-y-2 pt-1 border-t border-[#2b2d32]">
              <Label className="text-xs font-medium text-[#9aa0a6] uppercase tracking-wider flex items-center gap-1.5 pt-2">
                <Bot className="h-3.5 w-3.5" /> Default Chat Model
              </Label>
              <div className="flex flex-wrap gap-2">
                {chatModels.map((m) => {
                  const active = m.id === activeChatModelId
                  return (
                    <button
                      key={m.id}
                      type="button"
                      disabled={updateModelDefaults.isPending}
                      onClick={() =>
                        updateModelDefaults.mutate({ default_chat_model: m.id })
                      }
                      className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${
                        active
                          ? 'bg-[#8ab4f8] text-[#0e0f12] font-medium border-[#8ab4f8]'
                          : 'bg-[#141518] text-[#c4c7c5] border-[#2f3136] hover:bg-[#25262b]'
                      }`}
                    >
                      {m.name}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Thinking Effort Selector */}
          <div className="space-y-2">
            <Label className="text-xs font-medium text-[#9aa0a6] uppercase tracking-wider flex items-center gap-1.5">
              <Cpu className="h-3.5 w-3.5" /> Chat Thinking Effort
            </Label>
            <div className="flex flex-wrap gap-2">
              {REASONING_EFFORT_OPTIONS.map((opt) => {
                const active = reasoningEffort === opt.id
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setReasoningEffort(opt.id)}
                    className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${
                      active
                        ? 'bg-[#8ab4f8] text-[#0e0f12] font-medium border-[#8ab4f8]'
                        : 'bg-[#141518] text-[#c4c7c5] border-[#2f3136] hover:bg-[#25262b]'
                    }`}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Studio Model Info */}
          <div className="p-3 rounded-xl bg-[#141518] border border-[#2b2d32] flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 text-[#9aa0a6]">
              <Sparkles className="h-3.5 w-3.5 text-amber-400" />
              <span>
                Infographics powered by <strong className="text-[#e8eaed]">gpt-6.2-sol</strong> · Chat by{' '}
                <strong className="text-[#e8eaed]">{activeChatModelName}</strong>
              </span>
            </div>
          </div>
        </div>

        <div className="pt-3 border-t border-[#2b2d32] flex items-center justify-between">
          <div className="flex items-center gap-3 text-xs">
            <Link
              href="/settings/models"
              className="text-[#8ab4f8] hover:underline flex items-center gap-1"
            >
              Models <ExternalLink className="h-3 w-3" />
            </Link>
            <Link
              href="/settings"
              className="text-[#8ab4f8] hover:underline flex items-center gap-1"
            >
              App Settings <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
          <Button
            size="sm"
            onClick={() => onOpenChange(false)}
            className="rounded-full bg-[#e8eaed] text-[#0e0f12] hover:bg-white px-5"
          >
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
