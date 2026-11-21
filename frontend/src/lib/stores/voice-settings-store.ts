'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type VoiceEngine = 'local-kokoro' | 'openai-edge' | 'gemini-live'

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

interface VoiceSettingsState {
  engine: VoiceEngine
  voiceModel: string
  reasoningEffort: ReasoningEffort
  kokoroVoice: string
  edgeVoice: string
  geminiApiKey: string
  webSearchEnabled: boolean
  unreadNoteIds: string[]
  setEngine: (engine: VoiceEngine) => void
  setVoiceModel: (model: string) => void
  setReasoningEffort: (effort: ReasoningEffort) => void
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
      engine: 'local-kokoro',
      voiceModel: 'match-chat',
      reasoningEffort: 'none',
      kokoroVoice: 'af_heart',
      edgeVoice: 'en-US-AvaMultilingualNeural',
      geminiApiKey: '',
      webSearchEnabled: false,
      unreadNoteIds: [],
      setEngine: (engine) => set({ engine }),
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
    }
  )
)
