'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type VoiceEngine = 'gemini-live' | 'local-kokoro'
export type GeminiSendMode = 'manual' | 'hands-free'

export const GEMINI_SEND_MODE_OPTIONS: {
  id: GeminiSendMode
  label: string
  description: string
}[] = [
  {
    id: 'manual',
    label: 'Press ↑ to send',
    description: 'Dictate into the chat box, edit if needed, then click ↑ for Gemini Live voice reply',
  },
  {
    id: 'hands-free',
    label: 'Hands-free',
    description: 'Live voice conversation — Gemini responds automatically when you pause',
  },
]

export const VOICE_ENGINE_OPTIONS: {
  id: VoiceEngine
  title: string
  shortLabel: string
  subtitle: string
  badge: string
}[] = [
  {
    id: 'gemini-live',
    title: 'Gemini Live',
    shortLabel: 'Gemini Live',
    subtitle: 'Native real-time speech-to-speech via Gemini Live (speak naturally, instant voice replies)',
    badge: 'Default · Cloud S2S',
  },
  {
    id: 'local-kokoro',
    title: 'Local Voice + Chat Model',
    shortLabel: 'Local Voice',
    subtitle: 'Local Whisper STT + your selected Chat Model (streaming) + local Kokoro-82M voice',
    badge: 'Local Voice',
  },
]

export const GEMINI_LIVE_VOICES = [
  { id: 'Kore', label: 'Kore (Firm)' },
  { id: 'Puck', label: 'Puck (Upbeat)' },
  { id: 'Charon', label: 'Charon (Warm)' },
  { id: 'Fenrir', label: 'Fenrir (Deep)' },
  { id: 'Aoede', label: 'Aoede (Breezy)' },
] as const

export const KOKORO_VOICES = [
  { id: 'af_heart', label: 'Heart (US Female)' },
  { id: 'af_bella', label: 'Bella (US Female)' },
  { id: 'am_michael', label: 'Michael (US Male)' },
  { id: 'bf_emma', label: 'Emma (UK Female)' },
] as const

export const EDGE_VOICES = [
  { id: 'en-US-AvaMultilingualNeural', label: 'Ava (Natural Female)' },
  { id: 'en-US-AndrewMultilingualNeural', label: 'Andrew (Natural Male)' },
  { id: 'en-US-EmmaMultilingualNeural', label: 'Emma (Warm Female)' },
] as const

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high'

export const REASONING_EFFORT_OPTIONS: { id: ReasoningEffort; label: string }[] = [
  { id: 'none', label: 'Off' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Med' },
  { id: 'high', label: 'High' },
]

export const VOICE_LLM_OPTIONS = [
  { id: 'match-chat', label: 'Match Chat Model' },
  { id: 'gpt-6-luna', label: 'gpt-6-luna (Fastest)' },
  { id: 'gpt-6.1-terra', label: 'gpt-6.1-terra' },
  { id: 'gpt-6.2-sol', label: 'gpt-6.2-sol' },
  { id: 'gpt-6.2-astra', label: 'gpt-6.2-astra' },
] as const

export const MIN_CONTEXT_WINDOW_TOKENS = 8000

export function getModelMaxContextTokens(modelName: string): number {
  const m = (modelName || '').toLowerCase()
  if (m.includes('gemini-2.5') || m.includes('gemini-3') || m.includes('gemini-4')) {
    return 1000000
  }
  if (m.includes('gpt-6.1-terra') || m.includes('gpt-6.2-sol') || m.includes('gpt-6.1-sol')) {
    return 500000
  }
  if (m.includes('gpt-6') || m.includes('gpt-5.6') || m.includes('gpt-reserve')) {
    return 272000
  }
  if (m.includes('claude')) {
    return 200000
  }
  return 128000
}

interface VoiceSettingsState {
  engine: VoiceEngine
  geminiSendMode: GeminiSendMode
  voiceModel: string
  reasoningEffort: ReasoningEffort
  /** null means "use maximum context window supported by the chosen model" */
  contextWindowTokens: number | null
  geminiVoice: string
  kokoroVoice: string
  edgeVoice: string
  geminiApiKey: string
  webSearchEnabled: boolean
  unreadNoteIds: string[]
  setEngine: (engine: VoiceEngine) => void
  setGeminiSendMode: (mode: GeminiSendMode) => void
  setVoiceModel: (model: string) => void
  setReasoningEffort: (effort: ReasoningEffort) => void
  setContextWindowTokens: (tokens: number | null) => void
  setGeminiVoice: (voice: string) => void
  setKokoroVoice: (voice: string) => void
  setEdgeVoice: (voice: string) => void
  setGeminiApiKey: (key: string) => void
  setWebSearchEnabled: (enabled: boolean) => void
  markNoteUnread: (noteId: string) => void
  markNoteRead: (noteId: string) => void
}

export const useVoiceSettingsStore = create<VoiceSettingsState>()(
  persist(
    (set) => ({
      engine: 'gemini-live',
      geminiSendMode: 'manual',
      voiceModel: 'match-chat',
      reasoningEffort: 'none',
      contextWindowTokens: null,
      geminiVoice: 'Kore',
      kokoroVoice: 'af_heart',
      edgeVoice: 'en-US-AvaMultilingualNeural',
      geminiApiKey: '',
      webSearchEnabled: false,
      unreadNoteIds: [],
      setEngine: (engine) => set({ engine }),
      setGeminiSendMode: (geminiSendMode) => set({ geminiSendMode }),
      setVoiceModel: (voiceModel) => set({ voiceModel }),
      setReasoningEffort: (reasoningEffort) => {
        if (typeof window !== 'undefined') {
          fetch('http://127.0.0.1:8088/v1/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reasoning_effort: reasoningEffort }),
          }).catch(() => {})
        }
        set({ reasoningEffort })
      },
      setContextWindowTokens: (contextWindowTokens) => {
        if (typeof window !== 'undefined') {
          fetch('http://127.0.0.1:8088/v1/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ max_context_tokens: contextWindowTokens }),
          }).catch(() => {})
        }
        set({ contextWindowTokens })
      },
      setGeminiVoice: (geminiVoice) => set({ geminiVoice }),
      setKokoroVoice: (kokoroVoice) => set({ kokoroVoice }),
      setEdgeVoice: (edgeVoice) => set({ edgeVoice }),
      setGeminiApiKey: (geminiApiKey) => {
        if (typeof window !== 'undefined' && geminiApiKey) {
          localStorage.setItem('gemini_api_key', geminiApiKey)
        }
        set({ geminiApiKey })
      },
      setWebSearchEnabled: (webSearchEnabled) => set({ webSearchEnabled }),
      markNoteUnread: (noteId) =>
        set((state) => ({
          unreadNoteIds: state.unreadNoteIds.includes(noteId)
            ? state.unreadNoteIds
            : [...state.unreadNoteIds, noteId],
        })),
      markNoteRead: (noteId) =>
        set((state) => ({
          unreadNoteIds: state.unreadNoteIds.filter((id) => id !== noteId),
        })),
    }),
    {
      name: 'open-notebook-voice-settings',
      version: 3,
      migrate: (persistedState: unknown, version: number) => {
        const state = (persistedState as Record<string, unknown>) || {}
        const nextEngine =
          state.engine === 'local-kokoro' ? 'local-kokoro' : 'gemini-live'
        return {
          ...state,
          engine: version < 2 ? 'gemini-live' : nextEngine,
          geminiVoice: (state.geminiVoice as string) || 'Kore',
          geminiSendMode:
            state.geminiSendMode === 'hands-free' ? 'hands-free' : 'manual',
        }
      },
    }
  )
)
