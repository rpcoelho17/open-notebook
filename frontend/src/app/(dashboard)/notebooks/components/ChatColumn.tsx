'use client'

import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { useNotebookChat } from '@/lib/hooks/use-notebook-chat'
import { useNotes, useCreateNote } from '@/lib/hooks/use-notes'
import { useNotebook } from '@/lib/hooks/use-notebooks'
import { useModels, useModelDefaults } from '@/lib/hooks/use-models'
import { chatApi } from '@/lib/api/chat'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { GeminiLiveIcon } from '@/components/common/GeminiLiveIcon'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { SessionManager } from '@/components/sources/SessionManager'
import {
  convertReferencesToCompactMarkdown,
  createCompactReferenceLinkComponent,
} from '@/lib/utils/source-references'
import { useModalManager } from '@/lib/hooks/use-modal-manager'
import {
  useVoiceSettingsStore,
  VOICE_ENGINE_OPTIONS,
  GEMINI_SEND_MODE_OPTIONS,
  REASONING_EFFORT_OPTIONS,
} from '@/lib/stores/voice-settings-store'
import { ContextSelections } from '../[id]/page'
import { SourceListResponse } from '@/lib/types/api'
import {
  ArrowUp,
  Pin,
  Copy,
  Check,
  Loader2,
  SlidersHorizontal,
  RefreshCw,
  Laptop,
  Sparkles,
  Globe,
  MessageSquare,
  Volume2,
  VolumeX,
  Trash2,
} from 'lucide-react'
import { format } from 'date-fns'
import { toast } from 'sonner'

const BRIDGE_BASE = 'http://127.0.0.1:8088'
const BRIDGE_CHAT_URL = `${BRIDGE_BASE}/v1/chat/completions`
const BRIDGE_SEARCH_URL = `${BRIDGE_BASE}/v1/search`
const LOCAL_STT_URL = `${BRIDGE_BASE}/v1/audio/transcriptions`
const LOCAL_TTS_URL = `${BRIDGE_BASE}/v1/audio/speech`
const SUMMARY_MODEL = 'gpt-6-luna'

interface ChatColumnProps {
  notebookId: string
  contextSelections: ContextSelections
  sources: SourceListResponse[]
  sourcesLoading: boolean
  onOpenSettings?: () => void
}

interface InlineVoiceTurn {
  id: string
  type: 'human' | 'ai'
  content: string
}

function buildQuickTitle(content: string, fallback: string): string {
  const cleaned = content
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/[`*_]/g, '')
    .trim()
  const firstLine = cleaned.split(/\n+/)[0] || fallback
  const firstSentence = firstLine.split(/(?<=[.!?])\s+/)[0] || firstLine
  if (firstSentence.length <= 68) return firstSentence
  return firstSentence.slice(0, 65).trim() + '...'
}

async function generateShortNoteTitle(content: string, fallback: string): Promise<string> {
  try {
    const res = await fetch(BRIDGE_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        reasoning_effort: 'low',
        messages: [
          {
            role: 'system',
            content:
              'Generate a single concise 5-to-8 word title summarizing the following note. Output ONLY the plain title with no quotes, markdown, or trailing period.',
          },
          { role: 'user', content: content.slice(0, 1500) },
        ],
        stream: false,
      }),
    })
    if (res.ok) {
      const data = await res.json()
      const candidate = (data?.choices?.[0]?.message?.content || '')
        .replace(/^["'#*\s]+|["'.\s]+$/g, '')
        .trim()
      if (candidate.length >= 4 && candidate.length <= 90) {
        return candidate
      }
    }
  } catch {
    // fall back cleanly
  }
  return buildQuickTitle(content, fallback)
}

function cleanForSpeech(raw: string): string {
  return raw
    .replace(/[*#_`~>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function floatTo16kPcmBase64(input: Float32Array, inputSampleRate: number): string {
  const ratio = inputSampleRate / 16000
  const outLen = Math.max(1, Math.floor(input.length / ratio))
  const pcm16 = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const srcIdx = Math.min(input.length - 1, Math.floor(i * ratio))
    const s = Math.max(-1, Math.min(1, input[srcIdx]))
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  const bytes = new Uint8Array(pcm16.buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function base64Pcm24kToFloat32(b64: string): Float32Array {
  const binary = atob(b64)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  const pcm16 = new Int16Array(bytes.buffer)
  const float32 = new Float32Array(pcm16.length)
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / 32768
  }
  return float32
}

// Extract earliest natural phrase from streaming text so speech starts fast without chopping words
function popSpeakableChunk(buffer: string, isFirstChunk: boolean): [string, string] | null {
  // 1. Sentence boundary (. ! ? followed by space or newline)
  const sentenceMatch = buffer.match(/^([\s\S]*?[.!?])(?:\s+|\n|$)/)
  if (sentenceMatch && sentenceMatch[1].trim().length >= (isFirstChunk ? 10 : 18)) {
    return [sentenceMatch[1].trim(), buffer.slice(sentenceMatch[0].length)]
  }
  // 2. Newline boundary
  const nlIdx = buffer.indexOf('\n')
  if (nlIdx >= (isFirstChunk ? 14 : 22)) {
    return [buffer.slice(0, nlIdx).trim(), buffer.slice(nlIdx + 1)]
  }
  // 3. For the VERY FIRST chunk, flush on a clause break (, ; : —) after ~18 chars
  if (isFirstChunk && buffer.length >= 20) {
    const clauseMatch = buffer.match(/^([\s\S]{16,}?[,;:—–])(?:\s+)/)
    if (clauseMatch) {
      return [clauseMatch[1].trim(), buffer.slice(clauseMatch[0].length)]
    }
    // Or after 6 complete words (~34+ chars) so voice starts right behind streaming text!
    const words = buffer.match(/^\S+(?:\s+\S+){5,}\s+/)
    if (words && words[0].trim().length >= 24) {
      return [words[0].trim(), buffer.slice(words[0].length)]
    }
  }
  return null
}

export function ChatColumn({
  notebookId,
  contextSelections,
  sources,
  sourcesLoading,
}: ChatColumnProps) {
  const { data: notebook } = useNotebook(notebookId)
  const { data: notes = [], isLoading: notesLoading } = useNotes(notebookId)
  const { data: allModels = [] } = useModels()
  const { data: modelDefaults } = useModelDefaults()
  const createNote = useCreateNote()
  const { openModal } = useModalManager()
  const {
    engine,
    geminiSendMode,
    voiceModel,
    reasoningEffort,
    geminiVoice,
    kokoroVoice,
    edgeVoice,
    markNoteUnread,
    webSearchEnabled,
    setEngine,
    setGeminiSendMode,
    setWebSearchEnabled,
    setReasoningEffort,
  } = useVoiceSettingsStore()

  // Resolve active LLM for streaming voice replies
  const defaultChatModelName =
    allModels.find((m) => m.id === modelDefaults?.default_chat_model)?.name || SUMMARY_MODEL
  const resolvedVoiceModel =
    voiceModel && voiceModel !== 'match-chat' ? voiceModel : defaultChatModelName

  // Inline Voice Mode state (no popup modal!)
  const [voiceModeActive, setVoiceModeActive] = useState(false)
  const [micLevel, setMicLevel] = useState(0) // 0..1 live audio level for flickering blue aura
  const [isTranscribingChunk, setIsTranscribingChunk] = useState(false)
  const [isStreamingVoiceReply, setIsStreamingVoiceReply] = useState(false)
  const [isAiSpeaking, setIsAiSpeaking] = useState(false)
  const [streamingReplyText, setStreamingReplyText] = useState('')
  const [voiceTurns, setVoiceTurns] = useState<InlineVoiceTurn[]>([])

  // Session manager modal & composer sliders popover
  const [sessionManagerOpen, setSessionManagerOpen] = useState(false)
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false)
  const [isSearchingWeb, setIsSearchingWeb] = useState(false)
  const toolsMenuRef = useRef<HTMLDivElement>(null)

  // Composer state
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Auto-summary state
  const [autoSummary, setAutoSummary] = useState<string>('')
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false)
  const lastSummaryKeyRef = useRef<string>('')

  // Per-message Save / Copy / Read Aloud / Delete UI feedback
  const [savingId, setSavingId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [readingId, setReadingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Inline Voice Refs
  const voiceActiveRef = useRef(false)
  const isRespondingRef = useRef(false)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const levelTimerRef = useRef<number | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const speechDetectedRef = useRef(false)
  const silenceStartRef = useRef<number | null>(null)
  const speechRecRef = useRef<unknown>(null)
  const committedDictationRef = useRef('')
  const ttsAbortRef = useRef<AbortController | null>(null)
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null)
  const ttsAudioUrlRef = useRef<string | null>(null)

  const engineRef = useRef(engine)
  const geminiSendModeRef = useRef(geminiSendMode)
  const geminiVoiceRef = useRef(geminiVoice)
  const kokoroVoiceRef = useRef(kokoroVoice)
  const edgeVoiceRef = useRef(edgeVoice)
  const voiceModelRef = useRef(resolvedVoiceModel)

  // Gemini Live S2S WebSocket + WebAudio refs
  const geminiWsRef = useRef<WebSocket | null>(null)
  const geminiMicCtxRef = useRef<AudioContext | null>(null)
  const geminiProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const geminiPlayCtxRef = useRef<AudioContext | null>(null)
  const geminiNextPlayTimeRef = useRef(0)
  const geminiActiveSourcesRef = useRef<AudioBufferSourceNode[]>([])
  const geminiUserBufRef = useRef('')
  const geminiUserCommittedRef = useRef(false)
  const geminiAiBufRef = useRef('')
  const geminiSpeakingTimerRef = useRef<number | null>(null)
  const geminiAiSpeakingRef = useRef(false)
  const geminiEchoTailUntilRef = useRef(0)
  const geminiLastVoiceActivityRef = useRef(0)
  const resumeDictationAfterAiRef = useRef<() => void>(() => {})
  const [geminiConnecting, setGeminiConnecting] = useState(false)

  useEffect(() => {
    engineRef.current = engine
  }, [engine])
  useEffect(() => {
    geminiSendModeRef.current = geminiSendMode
  }, [geminiSendMode])
  useEffect(() => {
    geminiVoiceRef.current = geminiVoice
  }, [geminiVoice])
  useEffect(() => {
    kokoroVoiceRef.current = kokoroVoice
  }, [kokoroVoice])
  useEffect(() => {
    edgeVoiceRef.current = edgeVoice
  }, [edgeVoice])
  useEffect(() => {
    voiceModelRef.current = resolvedVoiceModel
  }, [resolvedVoiceModel])

  useEffect(() => {
    if (!toolsMenuOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (toolsMenuRef.current && !toolsMenuRef.current.contains(e.target as Node)) {
        setToolsMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [toolsMenuOpen])

  const chat = useNotebookChat({
    notebookId,
    sources,
    notes,
    contextSelections,
  })

  // Clear local optimistic voice turns whenever user switches chat sessions
  useEffect(() => {
    setVoiceTurns([])
  }, [chat.currentSessionId])

  const appendVoiceTurn = useCallback((turn: InlineVoiceTurn) => {
    setVoiceTurns((prev) => [...prev, turn])
  }, [])

  // Fire-and-forget async database persistence via same-origin Next.js /api proxy + keepalive
  // (zero CORS preflight, survives immediate page refresh, never blocks voice playback!)
  const persistVoiceTurnToDb = useCallback(
    async (question: string, answer: string) => {
      try {
        let sessionId = chat.currentSessionId
        if (!sessionId) {
          const title = question.length > 36 ? `${question.slice(0, 36)}...` : question
          const createRes = await fetch('/api/chat/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              notebook_id: notebookId,
              title: title || 'Voice Chat',
            }),
            keepalive: true,
          })
          if (!createRes.ok) throw new Error(`Create session HTTP ${createRes.status}`)
          const created = await createRes.json()
          sessionId = created.id
        }
        if (!sessionId) return

        const appendRes = await fetch(
          `/api/chat/sessions/${encodeURIComponent(sessionId)}/append`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              user_message: question,
              ai_message: answer,
            }),
            keepalive: true,
          }
        )
        if (!appendRes.ok) {
          throw new Error(`Append HTTP ${appendRes.status}`)
        }
      } catch (err) {
        console.error('Failed to persist voice turn to database:', err)
        toast.error('Could not save voice turn to database')
      }
    },
    [chat.currentSessionId, notebookId]
  )

  // Auto-resize composer textarea whenever dictated or typed text updates
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`
    }
  }, [input])

  // Stop active TTS playback + abort streaming reply cleanly
  const stopVoicePlayback = useCallback(() => {
    if (ttsAbortRef.current) {
      ttsAbortRef.current.abort()
      ttsAbortRef.current = null
    }
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause()
      ttsAudioRef.current.src = ''
      ttsAudioRef.current = null
    }
    if (ttsAudioUrlRef.current) {
      URL.revokeObjectURL(ttsAudioUrlRef.current)
      ttsAudioUrlRef.current = null
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
    }
    setIsAiSpeaking(false)
    setIsStreamingVoiceReply(false)
    setReadingId(null)
  }, [])

  const fetchTtsBlob = useCallback(async (text: string, signal: AbortSignal): Promise<Blob | null> => {
    const clean = cleanForSpeech(text)
    if (!clean) return null
    const provider = 'kokoro'
    const voice = kokoroVoiceRef.current || 'af_heart'

    const res = await fetch(LOCAL_TTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, voice, input: clean, speed: 1.0 }),
      signal,
    })
    if (!res.ok) return null
    return await res.blob()
  }, [])

  const playAudioBlob = useCallback((blob: Blob, signal: AbortSignal): Promise<void> => {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      const url = URL.createObjectURL(blob)
      ttsAudioUrlRef.current = url
      const audio = new Audio(url)
      ttsAudioRef.current = audio

      const cleanup = () => {
        signal.removeEventListener('abort', onAbort)
        if (ttsAudioUrlRef.current === url) {
          URL.revokeObjectURL(url)
          ttsAudioUrlRef.current = null
        }
        if (ttsAudioRef.current === audio) {
          ttsAudioRef.current = null
        }
        resolve()
      }
      const onAbort = () => {
        audio.pause()
        audio.src = ''
        cleanup()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      audio.onended = cleanup
      audio.onerror = cleanup
      audio.play().catch(cleanup)
    })
  }, [])

  // Stop all mic capture + speech recognition
  const stopMicCapture = useCallback(() => {
    if (levelTimerRef.current) {
      window.clearInterval(levelTimerRef.current)
      levelTimerRef.current = null
    }
    if (speechRecRef.current) {
      try {
        ;(speechRecRef.current as { stop: () => void }).stop()
      } catch {
        // ignore
      }
      speechRecRef.current = null
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop()
      } catch {
        // ignore
      }
    }
    mediaRecorderRef.current = null
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop())
      mediaStreamRef.current = null
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {})
      audioCtxRef.current = null
    }
    setMicLevel(0)
  }, [])

  // Rolling local faster-whisper dictation fallback (for embedded webviews without Web Speech API)
  const startWhisperDictationCycleRef = useRef<() => void>(() => {})

  const transcribeDictationBlob = useCallback(async (blob: Blob) => {
    if (!voiceActiveRef.current || isRespondingRef.current || blob.size < 1400) return
    setIsTranscribingChunk(true)
    try {
      const res = await fetch(LOCAL_STT_URL, {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      })
      if (res.ok) {
        const data = await res.json()
        const chunk = (data?.text || '').trim()
        if (chunk && voiceActiveRef.current && !isRespondingRef.current) {
          setInput((prev) => {
            const base = prev.trim()
            const next = base ? `${base} ${chunk}` : chunk
            committedDictationRef.current = next
            return next
          })
        }
      }
    } catch (err) {
      console.error('Dictation STT error:', err)
    } finally {
      setIsTranscribingChunk(false)
    }
  }, [])

  const startWhisperDictationCycle = useCallback(() => {
    const stream = mediaStreamRef.current
    if (!stream || !voiceActiveRef.current || isRespondingRef.current) return
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') return

    audioChunksRef.current = []
    speechDetectedRef.current = false
    silenceStartRef.current = null

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
      ? 'audio/webm'
      : ''
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream)

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        audioChunksRef.current.push(e.data)
      }
    }

    recorder.onstop = () => {
      const chunks = audioChunksRef.current
      audioChunksRef.current = []
      const hadSpeech = speechDetectedRef.current
      speechDetectedRef.current = false
      silenceStartRef.current = null

      if (hadSpeech && chunks.length > 0 && voiceActiveRef.current && !isRespondingRef.current) {
        const blob = new Blob(chunks, { type: mimeType || 'audio/webm' })
        transcribeDictationBlob(blob)
      }
      if (voiceActiveRef.current && !isRespondingRef.current && !speechRecRef.current) {
        setTimeout(() => startWhisperDictationCycleRef.current(), 120)
      }
    }

    mediaRecorderRef.current = recorder
    recorder.start(250)
  }, [transcribeDictationBlob])

  useEffect(() => {
    startWhisperDictationCycleRef.current = startWhisperDictationCycle
  }, [startWhisperDictationCycle])

  // Start Inline Voice Mode (mic aura + live dictation into chat bar)
  const startInlineVoiceMode = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      mediaStreamRef.current = stream
      voiceActiveRef.current = true
      setVoiceModeActive(true)
      committedDictationRef.current = input.trim()

      // Live mic RMS level analyser for the flickering blue aura + Whisper VAD pause trigger
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new AudioCtx()
      audioCtxRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      const dataArray = new Uint8Array(analyser.fftSize)

      levelTimerRef.current = window.setInterval(() => {
        if (!voiceActiveRef.current) return
        analyser.getByteTimeDomainData(dataArray)
        let sumSq = 0
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128
          sumSq += v * v
        }
        const rms = Math.sqrt(sumSq / dataArray.length)
        // Smooth normalized 0..1 level for the glowing aura
        const level = isRespondingRef.current ? 0 : Math.min(1, rms * 9)
        setMicLevel(level)

        // If using Whisper fallback recorder, flush a dictated phrase on a brief 750ms pause
        if (!speechRecRef.current && !isRespondingRef.current) {
          const rec = mediaRecorderRef.current
          if (rec && rec.state === 'recording') {
            if (rms > 0.022) {
              speechDetectedRef.current = true
              silenceStartRef.current = null
            } else if (speechDetectedRef.current) {
              if (silenceStartRef.current === null) {
                silenceStartRef.current = Date.now()
              } else if (Date.now() - silenceStartRef.current >= 750) {
                rec.stop()
              }
            }
          }
        }
      }, 75)

      // Try browser native SpeechRecognition first for instant word-by-word typing;
      // auto-fallback to rolling local faster-whisper if unavailable or network-blocked
      const SpeechRec =
        (window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown })
          .SpeechRecognition ||
        (window as unknown as { webkitSpeechRecognition?: new () => unknown }).webkitSpeechRecognition

      if (SpeechRec) {
        try {
          const rec = new SpeechRec() as {
            continuous: boolean
            interimResults: boolean
            lang: string
            onresult: (e: {
              resultIndex: number
              results: { length: number; [i: number]: { isFinal: boolean; 0: { transcript: string } } }
            }) => void
            onerror: (e: { error: string }) => void
            onend: () => void
            start: () => void
            stop: () => void
          }
          rec.continuous = true
          rec.interimResults = true
          rec.lang = 'en-US'

          rec.onresult = (event) => {
            if (!voiceActiveRef.current || isRespondingRef.current) return
            let interim = ''
            let finalAdded = ''
            for (let i = event.resultIndex; i < event.results.length; i++) {
              const transcript = event.results[i][0].transcript
              if (event.results[i].isFinal) {
                finalAdded += transcript + ' '
              } else {
                interim += transcript
              }
            }
            if (finalAdded.trim()) {
              committedDictationRef.current = [
                committedDictationRef.current.trim(),
                finalAdded.trim(),
              ]
                .filter(Boolean)
                .join(' ')
            }
            const combined = [committedDictationRef.current.trim(), interim.trim()]
              .filter(Boolean)
              .join(' ')
            setInput(combined)
          }

          rec.onerror = (e) => {
            if (e.error === 'network' || e.error === 'service-not-allowed' || e.error === 'not-allowed') {
              // Seamless fallback to local faster-whisper dictation!
              speechRecRef.current = null
              try {
                rec.stop()
              } catch {
                // ignore
              }
              if (voiceActiveRef.current && !isRespondingRef.current) {
                startWhisperDictationCycleRef.current()
              }
            }
          }

          rec.onend = () => {
            if (voiceActiveRef.current && !isRespondingRef.current && speechRecRef.current === rec) {
              try {
                rec.start()
              } catch {
                // ignore
              }
            }
          }

          speechRecRef.current = rec
          rec.start()
        } catch {
          speechRecRef.current = null
          startWhisperDictationCycleRef.current()
        }
      } else {
        startWhisperDictationCycleRef.current()
      }

      textareaRef.current?.focus()
    } catch (err: unknown) {
      toast.error('Microphone access denied: ' + ((err as Error)?.message || 'Allow mic permission'))
    }
  }, [input])

  // Stop scheduled Gemini Live audio buffers (used on barge-in, Stop button, or disconnect)
  const stopGeminiLivePlayback = useCallback(() => {
    if (geminiSpeakingTimerRef.current) {
      window.clearTimeout(geminiSpeakingTimerRef.current)
      geminiSpeakingTimerRef.current = null
    }
    for (const src of geminiActiveSourcesRef.current) {
      try {
        src.stop()
      } catch {
        // ignore
      }
    }
    geminiActiveSourcesRef.current = []
    if (geminiPlayCtxRef.current) {
      geminiNextPlayTimeRef.current = geminiPlayCtxRef.current.currentTime
    }
    geminiAiSpeakingRef.current = false
    geminiEchoTailUntilRef.current = Date.now() + 500
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getAudioTracks().forEach((t) => {
        t.enabled = true
      })
    }
    setIsAiSpeaking(false)
  }, [])

  const stopGeminiLiveSession = useCallback(() => {
    voiceActiveRef.current = false
    isRespondingRef.current = false
    setVoiceModeActive(false)
    setIsStreamingVoiceReply(false)
    setGeminiConnecting(false)
    stopGeminiLivePlayback()
    stopMicCapture()

    if (geminiProcessorRef.current) {
      try {
        geminiProcessorRef.current.disconnect()
      } catch {
        // ignore
      }
      geminiProcessorRef.current = null
    }
    if (geminiMicCtxRef.current && geminiMicCtxRef.current.state !== 'closed') {
      geminiMicCtxRef.current.close().catch(() => {})
      geminiMicCtxRef.current = null
    }
    if (geminiPlayCtxRef.current && geminiPlayCtxRef.current.state !== 'closed') {
      geminiPlayCtxRef.current.close().catch(() => {})
      geminiPlayCtxRef.current = null
    }
    if (geminiWsRef.current) {
      try {
        if (geminiWsRef.current.readyState === WebSocket.OPEN) {
          geminiWsRef.current.send(JSON.stringify({ type: 'close' }))
        }
        geminiWsRef.current.close()
      } catch {
        // ignore
      }
      geminiWsRef.current = null
    }

    // Preserve any partial AI transcript generated before stopping
    const leftoverUser = geminiUserBufRef.current.trim()
    const leftoverUserCommitted = geminiUserCommittedRef.current
    const leftoverAi = geminiAiBufRef.current.trim()
    geminiUserBufRef.current = ''
    geminiUserCommittedRef.current = false
    geminiAiBufRef.current = ''
    if (leftoverAi) {
      if (leftoverUser && !leftoverUserCommitted) {
        appendVoiceTurn({ id: `voice-user-${Date.now()}`, type: 'human', content: leftoverUser })
      }
      appendVoiceTurn({ id: `voice-ai-${Date.now() + 1}`, type: 'ai', content: leftoverAi })
      void persistVoiceTurnToDb(leftoverUser || '(Voice message)', leftoverAi)
    }
    setStreamingReplyText('')
    setMicLevel(0)
  }, [stopGeminiLivePlayback, stopMicCapture, appendVoiceTurn, persistVoiceTurnToDb])

  const startGeminiLiveSession = useCallback(async () => {
    const isManualMode = geminiSendModeRef.current === 'manual'
    setGeminiConnecting(true)
    try {
      let handsFreeStream: MediaStream | null = null
      if (!isManualMode) {
        handsFreeStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
        mediaStreamRef.current = handsFreeStream
      }

      // Fetch FULL text of every checked source so Gemini Live has every detail (not just short insights!)
      const checkedSources = sources.filter(
        (s) => (contextSelections.sources[s.id] ?? 'off') !== 'off'
      )
      const fullSourceBlocks = await Promise.all(
        checkedSources.map(async (s) => {
          try {
            const res = await fetch(`/api/sources/${encodeURIComponent(s.id)}`)
            if (res.ok) {
              const detail = await res.json()
              const body = String(detail.full_text || detail.content || '').slice(0, 35000)
              if (body.trim()) {
                return `[Source: ${detail.title || s.title || s.id}]\n${body}`
              }
            }
          } catch {
            // fall back below
          }
          return `[Source: ${s.title || s.id}]\n(No extracted text available)`
        })
      )
      const sourcesText = fullSourceBlocks.join('\n\n')

      const ctx = await chat.buildContext()
      const notesText = ((ctx?.notes as Array<Record<string, unknown>>) || [])
        .map(
          (n) =>
            `[Note: ${n.title || n.id || 'Untitled'}]\n${String(n.content || n.text || '').slice(
              0,
              6000
            )}`
        )
        .join('\n\n')

      const systemInstruction = `You are a knowledgeable, helpful voice research assistant for the notebook "${
        notebook?.name || 'Notebook'
      }".
Answer the user's spoken or typed questions directly based on the complete notebook sources and notes below.
Give clear, thorough, well-explained spoken answers — cite specific source names, numbers, and concrete details whenever relevant, and speak in natural conversational sentences rather than overly terse one-liners.

NOTEBOOK SOURCES:
---
${sourcesText.trim() || 'No source documents selected.'}
---

NOTEBOOK NOTES:
---
${notesText.trim() || 'No notes available.'}
---`

      const wsHost =
        typeof window !== 'undefined' ? window.location.hostname || '127.0.0.1' : '127.0.0.1'
      const wsProto = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${wsProto}://${wsHost}:5055/api/gemini-live/ws`)
      geminiWsRef.current = ws
      geminiUserBufRef.current = ''
      geminiUserCommittedRef.current = false
      geminiAiBufRef.current = ''

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const playCtx = new AudioCtx({ sampleRate: 24000 })
      geminiPlayCtxRef.current = playCtx
      geminiNextPlayTimeRef.current = playCtx.currentTime

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'setup',
            model: 'gemini-2.5-flash-native-audio-latest',
            voice: geminiVoiceRef.current || 'Kore',
            system_instruction: systemInstruction,
          })
        )
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string)
          if (msg.type === 'ready') {
            setGeminiConnecting(false)
            if (isManualMode) {
              // Press ↑ to send mode: dictate into the chat box (user reviews/edits and presses ↑)
              void startInlineVoiceMode()
            } else if (handsFreeStream) {
              voiceActiveRef.current = true
              setVoiceModeActive(true)
              // Hands-free mode: stream 16kHz PCM mic audio directly to Gemini Live
              const micCtx = new AudioCtx()
              geminiMicCtxRef.current = micCtx
              const micSrc = micCtx.createMediaStreamSource(handsFreeStream)
              const processor = micCtx.createScriptProcessor(4096, 1, 1)
              geminiProcessorRef.current = processor

              processor.onaudioprocess = (e) => {
                if (!voiceActiveRef.current || ws.readyState !== WebSocket.OPEN) return
                if (geminiAiSpeakingRef.current || Date.now() < geminiEchoTailUntilRef.current) {
                  setMicLevel(0)
                  return
                }
                const inputData = e.inputBuffer.getChannelData(0)
                let sumSq = 0
                for (let i = 0; i < inputData.length; i++) {
                  sumSq += inputData[i] * inputData[i]
                }
                const rms = Math.sqrt(sumSq / inputData.length)
                setMicLevel(Math.min(1, rms * 9))

                const now = Date.now()
                if (rms > 0.015) {
                  geminiLastVoiceActivityRef.current = now
                }
                if (now - geminiLastVoiceActivityRef.current <= 1200) {
                  const b64 = floatTo16kPcmBase64(inputData, micCtx.sampleRate)
                  ws.send(JSON.stringify({ type: 'audio', data: b64 }))
                }
              }

              micSrc.connect(processor)
              processor.connect(micCtx.destination)
            }
          } else if (msg.type === 'input_transcript' && msg.text) {
            if (!isManualMode && !geminiAiSpeakingRef.current && Date.now() >= geminiEchoTailUntilRef.current) {
              geminiUserBufRef.current += msg.text
              setInput(geminiUserBufRef.current.trim())
            }
          } else if (msg.type === 'output_transcript' && msg.text) {
            if (!geminiAiSpeakingRef.current) {
              geminiAiSpeakingRef.current = true
              if (!isManualMode) {
                if (handsFreeStream) {
                  handsFreeStream.getAudioTracks().forEach((t) => {
                    t.enabled = false
                  })
                }
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'audio_stream_end' }))
                }
                // Show spoken user question bubble immediately BEFORE the streaming answer!
                const spokenUser = geminiUserBufRef.current.trim()
                if (spokenUser && !geminiUserCommittedRef.current) {
                  geminiUserCommittedRef.current = true
                  appendVoiceTurn({ id: `voice-user-${Date.now()}`, type: 'human', content: spokenUser })
                  setInput('')
                }
              }
            }
            geminiAiBufRef.current += msg.text
            setStreamingReplyText(geminiAiBufRef.current)
          } else if (msg.type === 'audio' && msg.data) {
            if (!geminiAiSpeakingRef.current) {
              geminiAiSpeakingRef.current = true
              if (!isManualMode) {
                if (handsFreeStream) {
                  handsFreeStream.getAudioTracks().forEach((t) => {
                    t.enabled = false
                  })
                }
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'audio_stream_end' }))
                }
                const spokenUser = geminiUserBufRef.current.trim()
                if (spokenUser && !geminiUserCommittedRef.current) {
                  geminiUserCommittedRef.current = true
                  appendVoiceTurn({ id: `voice-user-${Date.now()}`, type: 'human', content: spokenUser })
                  setInput('')
                }
              }
            }
            const pCtx = geminiPlayCtxRef.current
            if (pCtx && pCtx.state !== 'closed') {
              if (pCtx.state === 'suspended') {
                pCtx.resume().catch(() => {})
              }
              const float32 = base64Pcm24kToFloat32(msg.data)
              const audioBuf = pCtx.createBuffer(1, float32.length, 24000)
              audioBuf.getChannelData(0).set(float32)
              const srcNode = pCtx.createBufferSource()
              srcNode.buffer = audioBuf
              srcNode.connect(pCtx.destination)
              const startAt = Math.max(pCtx.currentTime, geminiNextPlayTimeRef.current)
              srcNode.start(startAt)
              geminiNextPlayTimeRef.current = startAt + audioBuf.duration
              geminiActiveSourcesRef.current.push(srcNode)
              srcNode.onended = () => {
                geminiActiveSourcesRef.current = geminiActiveSourcesRef.current.filter(
                  (n) => n !== srcNode
                )
              }
              setIsAiSpeaking(true)
              if (geminiSpeakingTimerRef.current) {
                window.clearTimeout(geminiSpeakingTimerRef.current)
              }
              const remainMs = Math.max(150, (geminiNextPlayTimeRef.current - pCtx.currentTime) * 1000 + 180)
              geminiSpeakingTimerRef.current = window.setTimeout(() => {
                geminiSpeakingTimerRef.current = null
                geminiAiSpeakingRef.current = false
                geminiEchoTailUntilRef.current = Date.now() + 700
                geminiLastVoiceActivityRef.current = 0
                setIsAiSpeaking(false)
                if (isManualMode) {
                  isRespondingRef.current = false
                  setIsStreamingVoiceReply(false)
                  if (voiceActiveRef.current) {
                    resumeDictationAfterAiRef.current()
                  }
                } else if (voiceActiveRef.current && mediaStreamRef.current) {
                  mediaStreamRef.current.getAudioTracks().forEach((t) => {
                    t.enabled = true
                  })
                }
              }, remainMs)
            }
          } else if (msg.type === 'interrupted') {
            stopGeminiLivePlayback()
          } else if (msg.type === 'turn_complete') {
            if (!geminiSpeakingTimerRef.current) {
              geminiAiSpeakingRef.current = false
              geminiEchoTailUntilRef.current = Date.now() + 700
              geminiLastVoiceActivityRef.current = 0
              if (isManualMode) {
                isRespondingRef.current = false
                setIsStreamingVoiceReply(false)
                if (voiceActiveRef.current) {
                  resumeDictationAfterAiRef.current()
                }
              } else if (voiceActiveRef.current && mediaStreamRef.current) {
                mediaStreamRef.current.getAudioTracks().forEach((t) => {
                  t.enabled = true
                })
              }
            }
            const userText = geminiUserBufRef.current.trim()
            const alreadyCommitted = geminiUserCommittedRef.current
            const aiText = geminiAiBufRef.current.trim()
            geminiUserBufRef.current = ''
            geminiUserCommittedRef.current = false
            geminiAiBufRef.current = ''
            if (!isManualMode) {
              setInput('')
            }
            setStreamingReplyText('')
            setIsStreamingVoiceReply(false)
            if (aiText) {
              if (userText && !alreadyCommitted) {
                appendVoiceTurn({ id: `voice-user-${Date.now()}`, type: 'human', content: userText })
              }
              appendVoiceTurn({ id: `voice-ai-${Date.now() + 1}`, type: 'ai', content: aiText })
              void persistVoiceTurnToDb(userText || '(Voice message)', aiText)
            }
          } else if (msg.type === 'error') {
            toast.error(`Gemini Live: ${msg.message || 'Connection error'}`)
            stopGeminiLiveSession()
          }
        } catch {
          // ignore malformed event
        }
      }

      ws.onerror = () => {
        toast.error('Gemini Live WebSocket error — check that the Open Notebook API is running')
        stopGeminiLiveSession()
      }

      ws.onclose = () => {
        if (voiceActiveRef.current) {
          stopGeminiLiveSession()
        } else {
          setGeminiConnecting(false)
        }
      }
    } catch (err: unknown) {
      setGeminiConnecting(false)
      toast.error('Gemini Live failed: ' + ((err as Error)?.message || 'Allow microphone permission'))
      stopGeminiLiveSession()
    }
  }, [
    chat,
    sources,
    contextSelections.sources,
    notebook?.name,
    startInlineVoiceMode,
    stopGeminiLivePlayback,
    stopGeminiLiveSession,
    appendVoiceTurn,
    persistVoiceTurnToDb,
  ])

  const stopInlineVoiceMode = useCallback(() => {
    voiceActiveRef.current = false
    isRespondingRef.current = false
    setVoiceModeActive(false)
    stopVoicePlayback()
    stopMicCapture()
    if (geminiWsRef.current) {
      stopGeminiLiveSession()
    }
  }, [stopVoicePlayback, stopMicCapture, stopGeminiLiveSession])

  useEffect(() => {
    return () => {
      voiceActiveRef.current = false
      stopVoicePlayback()
      stopMicCapture()
      if (geminiWsRef.current) {
        stopGeminiLiveSession()
      }
    }
  }, [stopVoicePlayback, stopMicCapture, stopGeminiLiveSession])

  // Pause mic + SpeechRecognition completely while AI speaks so speaker audio NEVER bleeds into the input box
  const pauseDictationForAi = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getAudioTracks().forEach((t) => {
        t.enabled = false
      })
    }
    if (speechRecRef.current) {
      try {
        const rec = speechRecRef.current as { abort?: () => void; stop: () => void }
        if (rec.abort) rec.abort()
        else rec.stop()
      } catch {
        // ignore
      }
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      speechDetectedRef.current = false
      try {
        mediaRecorderRef.current.stop()
      } catch {
        // ignore
      }
    }
    setMicLevel(0)
  }, [])

  // Resume mic + SpeechRecognition after a short acoustic tail delay so speaker echo has faded
  const resumeDictationAfterAi = useCallback(() => {
    setTimeout(() => {
      if (!voiceActiveRef.current || isRespondingRef.current) return
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getAudioTracks().forEach((t) => {
          t.enabled = true
        })
      }
      if (speechRecRef.current) {
        try {
          ;(speechRecRef.current as { start: () => void }).start()
        } catch {
          // already started
        }
      } else {
        startWhisperDictationCycleRef.current()
      }
    }, 350)
  }, [])

  useEffect(() => {
    resumeDictationAfterAiRef.current = resumeDictationAfterAi
  }, [resumeDictationAfterAi])

  const handleToggleVoiceButton = () => {
    if (geminiConnecting) {
      stopGeminiLiveSession()
      return
    }
    // If AI is currently speaking (in Local Voice or Gemini Live Press-↑ mode), clicking interrupts speech & resumes dictation
    if (
      (engineRef.current !== 'gemini-live' || geminiSendModeRef.current === 'manual') &&
      (isAiSpeaking || isStreamingVoiceReply)
    ) {
      stopVoicePlayback()
      stopGeminiLivePlayback()
      isRespondingRef.current = false
      setIsStreamingVoiceReply(false)
      resumeDictationAfterAi()
      return
    }
    if (voiceModeActive) {
      if (geminiWsRef.current) {
        stopGeminiLiveSession()
      } else {
        stopInlineVoiceMode()
      }
    } else if (engineRef.current === 'gemini-live') {
      startGeminiLiveSession()
    } else {
      startInlineVoiceMode()
    }
  }

  // Count selected sources for the composer pill
  const selectedSourceCount = useMemo(() => {
    return sources.filter((s) => (contextSelections.sources[s.id] ?? 'off') !== 'off').length
  }, [sources, contextSelections.sources])

  // Ready sources signature to trigger auto-summary when sources are added/completed
  const readySourcesKey = useMemo(() => {
    const readyIds = sources
      .filter((s) => !s.status || s.status === 'completed')
      .map((s) => s.id)
      .sort()
    return readyIds.join(',')
  }, [sources])

  const generateOverviewSummary = useCallback(
    async (forceRefresh = false) => {
      if (!readySourcesKey) {
        setAutoSummary('')
        return
      }
      const cacheKey = `notebook_auto_summary_v1:${notebookId}:${readySourcesKey}`
      if (!forceRefresh && typeof window !== 'undefined') {
        const cached = localStorage.getItem(cacheKey)
        if (cached) {
          setAutoSummary(cached)
          return
        }
      }

      setIsGeneratingSummary(true)
      try {
        const ctx = await chat.buildContext()
        const srcBlocks = ((ctx?.sources as Array<Record<string, unknown>>) || []).map((s) => {
          const title = String(s.title || s.name || 'Source')
          const body = String(s.full_text || s.content || s.text || '')
          return `Source: ${title}\n${body.slice(0, 12000)}`
        })

        const combined = srcBlocks.join('\n\n').trim()
        if (!combined) {
          setIsGeneratingSummary(false)
          return
        }

        const res = await fetch(BRIDGE_CHAT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: SUMMARY_MODEL,
            reasoning_effort: 'low',
            messages: [
              {
                role: 'system',
                content:
                  'Write a crisp, high-signal single-paragraph NotebookLM-style overview (4-6 sentences) summarizing the provided notebook source(s). Bold the most important concepts/terms using **bold**. Do not add a heading or preamble.',
              },
              { role: 'user', content: combined.slice(0, 24000) },
            ],
            stream: false,
          }),
        })

        if (res.ok) {
          const data = await res.json()
          const summary = (data?.choices?.[0]?.message?.content || '').trim()
          if (summary) {
            setAutoSummary(summary)
            if (typeof window !== 'undefined') {
              localStorage.setItem(cacheKey, summary)
            }
          }
        }
      } catch (err) {
        console.error('Auto-summary failed:', err)
      } finally {
        setIsGeneratingSummary(false)
      }
    },
    [notebookId, readySourcesKey, chat]
  )

  useEffect(() => {
    if (sourcesLoading || !readySourcesKey) return
    if (lastSummaryKeyRef.current === `${notebookId}:${readySourcesKey}`) return
    lastSummaryKeyRef.current = `${notebookId}:${readySourcesKey}`
    generateOverviewSummary(false)
  }, [notebookId, readySourcesKey, sourcesLoading, generateOverviewSummary])

  // Auto-scroll ONLY when new messages are added or streaming text updates (never on deletion!)
  const prevTotalMessagesRef = useRef(0)
  useEffect(() => {
    const totalCount = chat.messages.length + voiceTurns.length
    const prevCount = prevTotalMessagesRef.current
    prevTotalMessagesRef.current = totalCount
    if (totalCount > prevCount || streamingReplyText) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [chat.messages.length, voiceTurns.length, streamingReplyText])

  // Save any summary or chat reply (optionally paired with the user's question) as a 1-line card in Studio
  const handleSaveToNote = async (itemId: string, content: string, question?: string) => {
    if (!content.trim() || savingId) return
    setSavingId(itemId)
    try {
      const titleSource = question ? `${question}\n${content}` : content
      const shortTitle = await generateShortNoteTitle(titleSource, notebook?.name || 'Saved Note')
      const noteBody = question
        ? `**Question:** ${question}\n\n---\n\n${content}`
        : content
      const created = await createNote.mutateAsync({
        notebook_id: notebookId,
        title: shortTitle,
        content: noteBody,
        note_type: 'ai',
      })
      if (created?.id) {
        markNoteUnread(created.id)
      }
      toast.success('Saved to Studio notes!')
    } catch (err) {
      console.error('Save to note failed:', err)
      toast.error('Failed to save note')
    } finally {
      setSavingId(null)
    }
  }

  const handleCopy = async (itemId: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      setCopiedId(itemId)
      setTimeout(() => setCopiedId(null), 1800)
    } catch {
      toast.error('Failed to copy')
    }
  }

  // Delete an AI answer from both the chat canvas and Open Notebook's database
  const handleDeleteMessage = async (messageId: string, content: string) => {
    if (deletingId) return
    setDeletingId(messageId)
    try {
      // Remove immediately from local optimistic voice turns if present
      setVoiceTurns((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId)
        if (idx === -1) return prev
        const removeIndices = new Set<number>([idx])
        if (idx > 0 && prev[idx - 1].type === 'human' && prev[idx - 1].content.trim() === '(Voice message)') {
          removeIndices.add(idx - 1)
        }
        return prev.filter((_, i) => !removeIndices.has(i))
      })

      const ok = await chat.deleteMessage(messageId, content)
      if (ok) {
        toast.success('Message deleted')
      }
    } finally {
      setDeletingId(null)
    }
  }

  // Read any overview summary or AI reply aloud sentence-by-sentence using Kokoro-82M / Edge Neural
  const handleReadAloud = async (itemId: string, content: string) => {
    if (readingId === itemId) {
      stopVoicePlayback()
      isRespondingRef.current = false
      if (voiceActiveRef.current) resumeDictationAfterAi()
      return
    }

    stopVoicePlayback()
    const clean = cleanForSpeech(content)
    if (!clean) return

    const wasVoiceOn = voiceActiveRef.current
    if (wasVoiceOn) {
      isRespondingRef.current = true
      pauseDictationForAi()
    }

    const abort = new AbortController()
    ttsAbortRef.current = abort
    setReadingId(itemId)
    setIsAiSpeaking(true)

    try {
      // Split into natural sentences so playback starts on Sentence 1 while Sentence 2 synthesizes in parallel
      const rawSentences = clean.match(/[^.!?\n]+[.!?\n]*/g) || [clean]
      const chunks = rawSentences.map((s) => s.trim()).filter(Boolean)
      const audioPromises = chunks.map((chunk) =>
        fetchTtsBlob(chunk, abort.signal).catch(() => null)
      )

      for (const blobPromise of audioPromises) {
        if (abort.signal.aborted) break
        const blob = await blobPromise
        if (!blob || abort.signal.aborted) continue
        await playAudioBlob(blob, abort.signal)
      }
    } catch (err: unknown) {
      if ((err as { name?: string })?.name !== 'AbortError') {
        console.error('Read aloud error:', err)
        toast.error('Read aloud failed — check local voice bridge')
      }
    } finally {
      setReadingId((prev) => (prev === itemId ? null : prev))
      setIsAiSpeaking(false)
      if (wasVoiceOn) {
        isRespondingRef.current = false
        if (voiceActiveRef.current) resumeDictationAfterAi()
      }
    }
  }

  // Streaming answer + pipelined first-phrase neural TTS when Voice Mode (blue icon) is ON
  const handleSendStreamingVoice = async (question: string) => {
    isRespondingRef.current = true
    stopVoicePlayback()
    pauseDictationForAi()

    const userTurnId = `voice-user-${Date.now()}`
    appendVoiceTurn({ id: userTurnId, type: 'human', content: question })
    setInput('')
    committedDictationRef.current = ''
    setIsStreamingVoiceReply(true)
    setStreamingReplyText('')

    const turnAbort = new AbortController()
    ttsAbortRef.current = turnAbort

    try {
      // 1. Build notebook context
      const ctx = await chat.buildContext()
      const sourcesText = ((ctx?.sources as Array<Record<string, unknown>>) || [])
        .map(
          (s) =>
            `[Source: ${s.title || s.name || s.id || 'Untitled'}]\n${
              s.content || s.full_text || s.text || JSON.stringify(s)
            }`
        )
        .join('\n\n')
      const notesText = ((ctx?.notes as Array<Record<string, unknown>>) || [])
        .map(
          (n) =>
            `[Note: ${n.title || n.id || 'Untitled'}]\n${n.content || n.text || JSON.stringify(n)}`
        )
        .join('\n\n')

      // 2. Optional Exa full-content web search if 🌐 Web is ON
      let webBlock = ''
      if (webSearchEnabled) {
        setIsSearchingWeb(true)
        try {
          const searchRes = await fetch(BRIDGE_SEARCH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: question, num_results: 5, max_characters: 4500 }),
            signal: turnAbort.signal,
          })
          if (searchRes.ok) {
            const searchData = await searchRes.json()
            const items = Array.isArray(searchData?.results) ? searchData.results : []
            if (items.length > 0) {
              webBlock =
                '\n\nLIVE WEB SEARCH RESULTS (EXA FULL CONTENT):\n---\n' +
                items
                  .map(
                    (r: { title?: string; url?: string; text?: string }) =>
                      `[${r.title || r.url}](${r.url})\n${r.text || ''}`
                  )
                  .join('\n\n') +
                '\n---'
            }
          }
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') return
          console.error('Exa search error:', err)
        } finally {
          setIsSearchingWeb(false)
        }
      }

      const systemPrompt = `You are a helpful, clear research assistant for the notebook "${notebook?.name || 'Notebook'}".
Answer the user's question directly based on the notebook sources, notes, and any live web results below.
Keep your answer well-structured and natural to listen to (avoid markdown tables; use clear sentences).

NOTEBOOK SOURCES:
---
${sourcesText.trim() || 'No source documents selected.'}
---

NOTEBOOK NOTES:
---
${notesText.trim() || 'No notes available.'}
---${webBlock}`

      const combinedHistory = [
        ...chat.messages.slice(-8).map((m) => ({
          role: m.type === 'human' ? 'user' : 'assistant',
          content: m.content,
        })),
        ...voiceTurns.slice(-8).map((m) => ({
          role: m.type === 'human' ? 'user' : 'assistant',
          content: m.content,
        })),
      ]

      // 3. Stream answer live from warm codex app-server
      const chatRes = await fetch(BRIDGE_CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: voiceModelRef.current || SUMMARY_MODEL,
          reasoning_effort: reasoningEffort || 'none',
          stream: true,
          messages: [
            { role: 'system', content: systemPrompt },
            ...combinedHistory,
            { role: 'user', content: question },
          ],
        }),
        signal: turnAbort.signal,
      })

      if (!chatRes.ok || !chatRes.body) {
        throw new Error(`Streaming bridge returned HTTP ${chatRes.status}`)
      }

      // 4. Pipelined TTS queue: speaks right behind the streaming text!
      const audioQueue: Promise<Blob | null>[] = []
      let streamFinished = false
      let queueNotify: (() => void) | null = null
      let firstChunkQueued = false

      const wakeQueue = () => {
        const fn = queueNotify
        queueNotify = null
        if (fn) fn()
      }

      const enqueueSpeakable = (phrase: string) => {
        const clean = cleanForSpeech(phrase)
        if (!clean) return
        firstChunkQueued = true
        const blobPromise = fetchTtsBlob(clean, turnAbort.signal).catch(() => null)
        audioQueue.push(blobPromise)
        wakeQueue()
      }

      const playbackPromise = (async () => {
        while (!turnAbort.signal.aborted) {
          if (audioQueue.length === 0) {
            if (streamFinished) break
            await new Promise<void>((resolve) => {
              queueNotify = resolve
            })
            continue
          }
          const nextPromise = audioQueue.shift()!
          const blob = await nextPromise
          if (!blob || turnAbort.signal.aborted) continue
          setIsAiSpeaking(true)
          await playAudioBlob(blob, turnAbort.signal)
        }
      })()

      // 5. Read SSE tokens live into center canvas + feed TTS queue
      const reader = chatRes.body.getReader()
      const decoder = new TextDecoder()
      let sseBuffer = ''
      let fullReply = ''
      let pendingSpeech = ''
      let replyCommitted = false

      const commitReply = () => {
        if (replyCommitted) return
        const finalText = fullReply.trim()
        if (finalText) {
          replyCommitted = true
          appendVoiceTurn({ id: `voice-ai-${Date.now()}`, type: 'ai', content: finalText })
          // Persist asynchronously to Open Notebook's database without interfering with voice playback
          void persistVoiceTurnToDb(question, finalText)
        }
        setStreamingReplyText('')
        setIsStreamingVoiceReply(false)
      }

      try {
        while (!turnAbort.signal.aborted) {
          const { value, done } = await reader.read()
          if (done) break
          sseBuffer += decoder.decode(value, { stream: true })
          const lines = sseBuffer.split('\n')
          sseBuffer = lines.pop() || ''

          for (const rawLine of lines) {
            const line = rawLine.trim()
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') continue
            try {
              const ev = JSON.parse(payload)
              const delta: string = ev?.choices?.[0]?.delta?.content || ''
              if (!delta) continue
              fullReply += delta
              pendingSpeech += delta
              setStreamingReplyText(fullReply)

              let popped = popSpeakableChunk(pendingSpeech, !firstChunkQueued)
              while (popped) {
                const [phrase, rest] = popped
                enqueueSpeakable(phrase)
                pendingSpeech = rest
                popped = popSpeakableChunk(pendingSpeech, !firstChunkQueued)
              }
            } catch {
              // ignore malformed chunk
            }
          }
        }
      } finally {
        // ALWAYS preserve whatever text was generated, even if Stop was clicked mid-stream or mid-speech!
        commitReply()
      }

      if (pendingSpeech.trim() && !turnAbort.signal.aborted) {
        enqueueSpeakable(pendingSpeech.trim())
      }
      streamFinished = true
      wakeQueue()

      await playbackPromise
    } catch (err: unknown) {
      if ((err as { name?: string })?.name !== 'AbortError') {
        console.error('Streaming voice error:', err)
        toast.error(`Voice stream error: ${(err as Error)?.message || 'Check local bridge'}`)
      }
      setStreamingReplyText('')
      setIsStreamingVoiceReply(false)
    } finally {
      setIsAiSpeaking(false)
      setIsSearchingWeb(false)
      isRespondingRef.current = false
      // Automatically resume live dictation after acoustic echo tail fades
      if (voiceActiveRef.current) {
        resumeDictationAfterAi()
      }
    }
  }

  const handleSend = async () => {
    const trimmed = input.trim()
    if (!trimmed || chat.isSending || isSearchingWeb || isStreamingVoiceReply) return

    // If Voice Mode (blue wavy icon) is ON:
    if (voiceModeActive) {
      if (
        engineRef.current === 'gemini-live' &&
        geminiWsRef.current &&
        geminiWsRef.current.readyState === WebSocket.OPEN
      ) {
        isRespondingRef.current = true
        setIsStreamingVoiceReply(true)
        pauseDictationForAi()
        geminiUserBufRef.current = trimmed
        geminiUserCommittedRef.current = true
        geminiAiBufRef.current = ''
        appendVoiceTurn({ id: `voice-user-${Date.now()}`, type: 'human', content: trimmed })
        setInput('')
        committedDictationRef.current = ''

        let payloadText = trimmed
        if (webSearchEnabled) {
          setIsSearchingWeb(true)
          try {
            const searchRes = await fetch(BRIDGE_SEARCH_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query: trimmed, num_results: 5, max_characters: 4500 }),
            })
            if (searchRes.ok) {
              const searchData = await searchRes.json()
              const items = Array.isArray(searchData?.results) ? searchData.results : []
              if (items.length > 0) {
                const webBlock = items
                  .map(
                    (r: { title?: string; url?: string; text?: string }) =>
                      `[${r.title || r.url}](${r.url})\n${r.text || ''}`
                  )
                  .join('\n\n')
                payloadText = `LIVE WEB SEARCH RESULTS (EXA):\n${webBlock}\n\nUSER QUESTION: ${trimmed}`
              }
            }
          } catch (err) {
            console.error('Exa search error in Gemini Live:', err)
          } finally {
            setIsSearchingWeb(false)
          }
        }

        if (geminiWsRef.current && geminiWsRef.current.readyState === WebSocket.OPEN) {
          geminiWsRef.current.send(JSON.stringify({ type: 'text', text: payloadText }))
        }
        return
      }
      await handleSendStreamingVoice(trimmed)
      return
    }

    let extraContext: Record<string, unknown> | undefined
    if (webSearchEnabled) {
      setIsSearchingWeb(true)
      try {
        const res = await fetch(BRIDGE_SEARCH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: trimmed,
            num_results: 5,
            max_characters: 4500,
          }),
        })
        if (res.ok) {
          const data = await res.json()
          const results = Array.isArray(data?.results) ? data.results : []
          if (results.length > 0) {
            extraContext = {
              web_search_note:
                'Live web search (Exa) is enabled for this turn. You have full page contents below in web_search_results. Synthesize them alongside the notebook sources and include clickable markdown links [Title](url) when citing web pages.',
              web_search_results: results,
            }
          }
        } else {
          toast.error('Exa web search failed; answering from notebook sources only.')
        }
      } catch (err) {
        console.error('Exa search error:', err)
        toast.error('Web search unreachable; answering from notebook sources only.')
      } finally {
        setIsSearchingWeb(false)
      }
    }

    const ok = await chat.sendMessage(trimmed, undefined, extraContext)
    if (ok) {
      setInput('')
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleReferenceClick = useCallback(
    (type: string, id: string) => {
      const modalType =
        type === 'source_insight' ? 'insight' : (type as 'source' | 'note' | 'insight')
      try {
        openModal(modalType, id)
      } catch {
        toast.error('Reference not found')
      }
    },
    [openModal]
  )

  const LinkComponent = useMemo(
    () => createCompactReferenceLinkComponent(handleReferenceClick),
    [handleReferenceClick]
  )

  if (sourcesLoading || notesLoading) {
    return (
      <div className="h-full flex items-center justify-center bg-[#0e0f12]">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  const formattedDate = notebook?.updated
    ? format(new Date(notebook.updated), 'MMM d, yyyy')
    : format(new Date(), 'MMM d, yyyy')

  const allDisplayMessages = [
    ...chat.messages.map((m) => ({ id: m.id, type: m.type, content: m.content })),
    ...voiceTurns,
  ]

  const isBusy = chat.isSending || isSearchingWeb || isStreamingVoiceReply

  return (
    <>
      <div className="h-full flex flex-col bg-[#0e0f12] overflow-hidden relative">
        {/* Scrollable Reading & Conversation Canvas */}
        <div className="flex-1 overflow-y-auto min-h-0 px-6 pt-5 pb-6">
          <div className="max-w-[740px] mx-auto space-y-6">
            {/* NotebookLM Overview Header + Auto-Summary */}
            <div className="space-y-4">
              <div className="h-10 w-10 rounded-xl bg-[#1c1d20] border border-[#2a2c31] flex items-center justify-center text-[#8ab4f8]">
                <Laptop className="h-5 w-5" />
              </div>

              <div>
                <h1 className="text-[28px] font-normal text-[#e8eaed] tracking-tight leading-snug">
                  {notebook?.name || 'Untitled Notebook'}
                </h1>
                <p className="text-[12.5px] text-[#9aa0a6] mt-1">
                  {sources.length} {sources.length === 1 ? 'source' : 'sources'} · {formattedDate}
                </p>
              </div>

              {/* Auto-generated Summary */}
              {sources.length === 0 ? (
                <div className="p-5 rounded-2xl bg-[#16171b] border border-[#26282e] text-sm text-[#9aa0a6] flex items-center gap-3">
                  <Sparkles className="h-5 w-5 text-[#8ab4f8] shrink-0" />
                  <span>
                    Add a source on the left to generate an automatic notebook overview and start
                    chatting or talking with your documents.
                  </span>
                </div>
              ) : isGeneratingSummary ? (
                <div className="py-4 flex items-center gap-2.5 text-sm text-[#9aa0a6]">
                  <Loader2 className="h-4 w-4 animate-spin text-[#8ab4f8]" />
                  <span>Summarizing your notebook sources...</span>
                </div>
              ) : autoSummary ? (
                <div className="space-y-3">
                  <div className="text-[14.5px] leading-[1.7] text-[#dcdfe4] prose prose-invert prose-p:my-0 prose-strong:text-[#ffffff] max-w-none">
                    <MarkdownRenderer>{autoSummary}</MarkdownRenderer>
                  </div>

                  {/* NotebookLM-style Save to Note Action Row */}
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => handleSaveToNote('overview-summary', autoSummary)}
                      disabled={savingId === 'overview-summary'}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-[#c4c7c5] hover:text-[#ffffff] hover:bg-[#1e1f24] border border-transparent hover:border-[#2f3136] transition-colors"
                    >
                      {savingId === 'overview-summary' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Pin className="h-3.5 w-3.5" />
                      )}
                      Save to note
                    </button>

                    <button
                      type="button"
                      onClick={() => handleCopy('overview-summary', autoSummary)}
                      className="h-7 w-7 rounded-full flex items-center justify-center text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#1e1f24] transition-colors"
                      title="Copy summary"
                    >
                      {copiedId === 'overview-summary' ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => handleReadAloud('overview-summary', autoSummary)}
                      className={`h-7 w-7 rounded-full flex items-center justify-center transition-colors ${
                        readingId === 'overview-summary'
                          ? 'bg-[#213352] text-[#8ab4f8]'
                          : 'text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#1e1f24]'
                      }`}
                      title={readingId === 'overview-summary' ? 'Stop reading' : 'Read aloud'}
                      aria-label={readingId === 'overview-summary' ? 'Stop reading' : 'Read aloud'}
                    >
                      {readingId === 'overview-summary' ? (
                        <VolumeX className="h-3.5 w-3.5" />
                      ) : (
                        <Volume2 className="h-3.5 w-3.5" />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => generateOverviewSummary(true)}
                      className="h-7 w-7 rounded-full flex items-center justify-center text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#1e1f24] transition-colors"
                      title="Regenerate overview"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            {/* Divider if conversation started */}
            {(allDisplayMessages.length > 0 || streamingReplyText) && (
              <div className="border-t border-[#23252b]" />
            )}

            {/* Chat Conversation Messages */}
            <div className="space-y-6">
              {allDisplayMessages.map((message, idx) => {
                if (message.type === 'human') {
                  return (
                    <div key={message.id} className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleDeleteMessage(message.id, message.content)}
                        disabled={deletingId === message.id}
                        className="h-7 w-7 rounded-full flex items-center justify-center shrink-0 text-[#9aa0a6] hover:text-red-400 hover:bg-[#1e1f24] transition-colors disabled:opacity-50"
                        title="Delete question from chat & database"
                        aria-label="Delete question"
                      >
                        {deletingId === message.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <div className="max-w-[82%] rounded-2xl bg-[#25262b] border border-[#32343a] px-4 py-2.5 text-[14px] text-[#e8eaed] leading-relaxed">
                        {message.content}
                      </div>
                    </div>
                  )
                }

                // Pair this AI answer with the immediately preceding user question (if present)
                const precedingQuestion =
                  idx > 0 && allDisplayMessages[idx - 1]?.type === 'human'
                    ? allDisplayMessages[idx - 1].content
                    : undefined

                const compactMd = convertReferencesToCompactMarkdown(
                  message.content,
                  'References'
                )

                return (
                  <div key={message.id} className="space-y-2.5">
                    <div className="text-[14.5px] leading-[1.7] text-[#dcdfe4] prose prose-invert prose-strong:text-white prose-code:bg-[#1c1d20] prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded max-w-none">
                      <MarkdownRenderer components={{ a: LinkComponent }}>
                        {compactMd}
                      </MarkdownRenderer>
                    </div>

                    {/* Exact NotebookLM Action Bar underneath AI reply */}
                    <div className="flex items-center gap-1.5 pt-0.5">
                      <button
                        type="button"
                        onClick={() => handleSaveToNote(message.id, message.content, precedingQuestion)}
                        disabled={savingId === message.id}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-[#c4c7c5] hover:text-white hover:bg-[#1e1f24] border border-transparent hover:border-[#2f3136] transition-colors"
                      >
                        {savingId === message.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Pin className="h-3.5 w-3.5" />
                        )}
                        Save to note
                      </button>

                      <button
                        type="button"
                        onClick={() => handleCopy(message.id, message.content)}
                        className="h-7 w-7 rounded-full flex items-center justify-center text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#1e1f24] transition-colors"
                        title="Copy response"
                      >
                        {copiedId === message.id ? (
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => handleReadAloud(message.id, message.content)}
                        className={`h-7 w-7 rounded-full flex items-center justify-center transition-colors ${
                          readingId === message.id
                            ? 'bg-[#213352] text-[#8ab4f8]'
                            : 'text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#1e1f24]'
                        }`}
                        title={readingId === message.id ? 'Stop reading' : 'Read aloud'}
                        aria-label={readingId === message.id ? 'Stop reading' : 'Read aloud'}
                      >
                        {readingId === message.id ? (
                          <VolumeX className="h-3.5 w-3.5" />
                        ) : (
                          <Volume2 className="h-3.5 w-3.5" />
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDeleteMessage(message.id, message.content)}
                        disabled={deletingId === message.id}
                        className="h-7 w-7 rounded-full flex items-center justify-center text-[#9aa0a6] hover:text-red-400 hover:bg-[#1e1f24] transition-colors disabled:opacity-50"
                        title="Delete answer from chat & database"
                        aria-label="Delete answer"
                      >
                        {deletingId === message.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                )
              })}

              {/* Live Streaming AI Reply (text streams ahead of voice!) */}
              {streamingReplyText && (
                <div className="space-y-2">
                  <div className="text-[14.5px] leading-[1.7] text-[#dcdfe4] prose prose-invert prose-strong:text-white prose-code:bg-[#1c1d20] prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded max-w-none">
                    <MarkdownRenderer>{streamingReplyText}</MarkdownRenderer>
                  </div>
                </div>
              )}

              {/* Status indicator (Searching / Thinking / Speaking) */}
              {(isSearchingWeb || (isBusy && !streamingReplyText) || isAiSpeaking) && (
                <div className="flex items-center gap-2.5 text-xs text-[#9aa0a6] py-1">
                  {isAiSpeaking ? (
                    <>
                      <Volume2 className="h-3.5 w-3.5 text-[#60a5fa]" />
                      <span className="text-[#8ab4f8]">Speaking...</span>
                      <button
                        type="button"
                        onClick={() => {
                          stopVoicePlayback()
                          stopGeminiLivePlayback()
                          if (
                            engineRef.current === 'gemini-live' &&
                            geminiSendModeRef.current === 'manual'
                          ) {
                            isRespondingRef.current = false
                            setIsStreamingVoiceReply(false)
                            if (voiceActiveRef.current) {
                              resumeDictationAfterAi()
                            }
                          }
                        }}
                        className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#1e2026] hover:bg-[#2a2d36] text-[#c4c7c5] transition-colors"
                      >
                        <VolumeX className="h-3 w-3" /> Stop
                      </button>
                    </>
                  ) : (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-[#8ab4f8]" />
                      <span>
                        {isSearchingWeb ? 'Searching the web with Exa...' : 'Thinking...'}
                      </span>
                    </>
                  )}
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </div>
        </div>

        {/* Floating NotebookLM Pill Composer (Inline Dictation + Blue Voice Aura + ArrowUp Send) */}
        <div className="flex-shrink-0 px-6 pb-3 pt-2 bg-gradient-to-t from-[#0e0f12] via-[#0e0f12] to-transparent">
          <div className="max-w-[740px] mx-auto relative" ref={toolsMenuRef}>
            {/* NotebookLM-style Popover above the Sliders Icon */}
            {toolsMenuOpen && (
              <div className="absolute bottom-full left-0 mb-2.5 w-[275px] rounded-2xl bg-[#1c1d21] border border-[#2f3138] shadow-2xl p-3 space-y-2.5 z-50">
                {/* 2-Option Speech-to-Speech Switcher */}
                <div className="px-2 py-1 space-y-1.5">
                  <span className="text-[11px] font-medium text-[#9aa0a6] uppercase tracking-wider block">
                    Speech-to-Speech
                  </span>
                  <div
                    role="radiogroup"
                    aria-label="Speech-to-Speech Engine"
                    className="grid grid-cols-2 gap-1.5"
                  >
                    {VOICE_ENGINE_OPTIONS.map((opt) => {
                      const active = engine === opt.id
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => {
                            if (voiceModeActive && engine !== opt.id) {
                              stopInlineVoiceMode()
                            }
                            setEngine(opt.id)
                          }}
                          className={`py-1.5 px-2 rounded-lg text-[11.5px] font-medium border transition-colors text-center ${
                            active
                              ? 'bg-[#8ab4f8] text-[#0e0f12] border-[#8ab4f8]'
                              : 'bg-[#141518] text-[#c4c7c5] border-[#2f3138] hover:bg-[#26282e]'
                          }`}
                        >
                          {opt.shortLabel}
                        </button>
                      )
                    })}
                  </div>

                  {engine === 'gemini-live' && (
                    <div className="pt-1.5 space-y-1">
                      <span className="text-[10.5px] font-medium text-[#9aa0a6] block">
                        Gemini Live Input
                      </span>
                      <div
                        role="radiogroup"
                        aria-label="Gemini Live Input Mode"
                        className="grid grid-cols-2 gap-1.5"
                      >
                        {GEMINI_SEND_MODE_OPTIONS.map((modeOpt) => {
                          const active = geminiSendMode === modeOpt.id
                          return (
                            <button
                              key={modeOpt.id}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              onClick={() => {
                                if (voiceModeActive && geminiSendMode !== modeOpt.id) {
                                  stopInlineVoiceMode()
                                }
                                setGeminiSendMode(modeOpt.id)
                              }}
                              className={`py-1 px-2 rounded-lg text-[11px] font-medium border transition-colors text-center ${
                                active
                                  ? 'bg-[#253a5e] text-[#a8c7fa] border-[#8ab4f8]/60'
                                  : 'bg-[#141518] text-[#9aa0a6] border-[#2f3138] hover:bg-[#26282e] hover:text-[#e8eaed]'
                              }`}
                            >
                              {modeOpt.label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>

                <div className="border-t border-[#2c2e35]" />

                <button
                  type="button"
                  role="switch"
                  aria-checked={webSearchEnabled}
                  onClick={() => setWebSearchEnabled(!webSearchEnabled)}
                  className="w-full flex items-center justify-between px-2 py-1.5 rounded-xl hover:bg-[#26282e] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <Globe className="h-4 w-4 text-[#4285f4]" />
                    <div className="text-left">
                      <span className="text-[13.5px] font-medium text-[#e8eaed] block leading-tight">
                        Web
                      </span>
                      <span className="text-[10.5px] text-[#9aa0a6]">Exa full page content</span>
                    </div>
                  </div>
                  <span
                    className={`w-10 h-6 rounded-full p-0.5 flex items-center transition-colors ${
                      webSearchEnabled ? 'bg-[#e8eaed] justify-end' : 'bg-[#35373e] justify-start'
                    }`}
                  >
                    <span
                      className={`h-5 w-5 rounded-full flex items-center justify-center transition-colors ${
                        webSearchEnabled ? 'bg-[#1a3c78] text-white' : 'bg-[#80868b] text-[#1c1d21]'
                      }`}
                    >
                      {webSearchEnabled && <Check className="h-3 w-3 stroke-[3]" />}
                    </span>
                  </span>
                </button>

                <div className="border-t border-[#2c2e35]" />

                {/* Thinking Effort Row (defaults to Off for snappy chat!) */}
                <div className="px-2 py-1 space-y-1.5">
                  <span className="text-[11px] font-medium text-[#9aa0a6] uppercase tracking-wider block">
                    Thinking Effort
                  </span>
                  <div className="grid grid-cols-4 gap-1">
                    {REASONING_EFFORT_OPTIONS.map((opt) => {
                      const active = reasoningEffort === opt.id
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setReasoningEffort(opt.id)}
                          className={`py-1 rounded-lg text-[11.5px] font-medium border transition-colors ${
                            active
                              ? 'bg-[#8ab4f8] text-[#0e0f12] border-[#8ab4f8]'
                              : 'bg-[#141518] text-[#c4c7c5] border-[#2f3138] hover:bg-[#26282e]'
                          }`}
                        >
                          {opt.label}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="border-t border-[#2c2e35]" />

                <button
                  type="button"
                  onClick={() => {
                    setToolsMenuOpen(false)
                    setSessionManagerOpen(true)
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl bg-[#141518] hover:bg-[#26282e] border border-[#2f3138] text-[13px] text-[#e8eaed] transition-colors"
                >
                  <MessageSquare className="h-4 w-4 text-[#9aa0a6]" />
                  <span>Chat sessions</span>
                </button>
              </div>
            )}

            <div
              className={`flex items-end gap-2 rounded-[28px] bg-[#1c1d20] border px-3 py-2 shadow-xl transition-colors ${
                voiceModeActive
                  ? 'border-[#3b82f6]/60 shadow-[0_0_24px_rgba(59,130,246,0.14)]'
                  : 'border-[#32343a] focus-within:border-[#4b4f58]'
              }`}
            >
              {/* Left: Sliders Button (opens Web toggle popover) */}
              <button
                type="button"
                onClick={() => setToolsMenuOpen((prev) => !prev)}
                className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                  webSearchEnabled || toolsMenuOpen
                    ? 'bg-[#213352] text-[#8ab4f8] border border-[#4285f4]/50'
                    : 'bg-[#26282e] hover:bg-[#32353d] text-[#c4c7c5]'
                }`}
                title="Search tools & sessions"
                aria-label="Search tools & sessions"
              >
                <SlidersHorizontal className="h-4 w-4" />
              </button>

              {/* Subtle active Web pill when Web Search is ON */}
              {webSearchEnabled && (
                <button
                  type="button"
                  onClick={() => setWebSearchEnabled(false)}
                  className="mb-1 px-2.5 py-1 rounded-full bg-[#1a2b49] border border-[#4285f4]/40 text-[#8ab4f8] text-[11px] font-medium flex items-center gap-1 shrink-0 hover:bg-[#22375c] transition-colors"
                  title="Exa Web Search is ON (click to turn off)"
                >
                  <Globe className="h-3 w-3" />
                  <span>Web</span>
                </button>
              )}

              {/* Center Input (receives live dictated words when Voice Mode is ON!) */}
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value)
                  committedDictationRef.current = e.target.value
                }}
                onKeyDown={handleKeyDown}
                placeholder={
                  geminiConnecting
                    ? 'Connecting to Gemini Live...'
                    : voiceModeActive
                    ? engine === 'gemini-live' && geminiSendMode === 'hands-free'
                      ? 'Gemini Live (Hands-free) — speak naturally, or type and press ↑'
                      : isTranscribingChunk
                      ? 'Transcribing...'
                      : 'Listening — speak now, then press ↑ to send...'
                    : 'Ask a question or create something'
                }
                disabled={isBusy}
                rows={1}
                className="flex-1 bg-transparent border-0 outline-none resize-none overflow-hidden text-[14px] text-[#e8eaed] placeholder:text-[#80868b] py-2 px-1.5 max-h-[120px] leading-snug"
              />

              {/* Source Count */}
              <span className="text-[11.5px] text-[#9aa0a6] px-1.5 pb-2.5 shrink-0 select-none">
                {selectedSourceCount} {selectedSourceCount === 1 ? 'source' : 'sources'}
              </span>

              {/* Icon 1: Arrow Pointing Up (Send typed or dictated text) */}
              <button
                type="button"
                onClick={handleSend}
                disabled={!input.trim() || isBusy}
                aria-label="Send message"
                title={voiceModeActive ? 'Send & speak streaming answer' : 'Send message'}
                className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                  input.trim() && !isBusy
                    ? 'bg-[#e8eaed] text-[#0e0f12] hover:bg-white'
                    : 'bg-[#2a2c32] text-[#6d7178] cursor-not-allowed'
                }`}
              >
                {isBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowUp className="h-4 w-4 stroke-[2.25]" />
                )}
              </button>

              {/* Icon 2: Inline Voice Mode Toggle (Blue + live mic-reactive flickering aura!) */}
              <div className="relative flex items-center justify-center shrink-0">
                {voiceModeActive && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 rounded-full bg-[#3b82f6] blur-md transition-transform duration-75"
                    style={{
                      transform: `scale(${isAiSpeaking ? 1.35 : 1.05 + micLevel * 0.65})`,
                      opacity: isAiSpeaking ? 0.6 : 0.25 + micLevel * 0.7,
                    }}
                  />
                )}
                <button
                  type="button"
                  onClick={handleToggleVoiceButton}
                  aria-label={voiceModeActive ? 'Turn off voice mode' : 'Turn on inline voice mode'}
                  aria-pressed={voiceModeActive}
                  title={
                    isAiSpeaking
                      ? 'Click to stop speaking'
                      : voiceModeActive
                      ? 'Voice mode ON — click to turn off'
                      : 'Turn on inline voice mode (dictate into chat + spoken streaming replies)'
                  }
                  className={`relative z-10 h-9 w-9 rounded-full flex items-center justify-center border transition-all duration-150 ${
                    voiceModeActive
                      ? 'bg-[#2563eb] hover:bg-[#1d4ed8] border-[#60a5fa] text-white'
                      : 'bg-[#262932] hover:bg-[#323846] border-[#3d4456] text-[#a8c7fa] hover:text-white'
                  }`}
                  style={
                    voiceModeActive
                      ? {
                          boxShadow: `0 0 ${10 + Math.round(micLevel * 18)}px rgba(59, 130, 246, ${
                            0.55 + micLevel * 0.45
                          })`,
                        }
                      : undefined
                  }
                >
                  <GeminiLiveIcon className="h-5 w-5" />
                </button>
              </div>
            </div>

            <p className="text-center text-[11px] text-[#757a82] mt-2 select-none">
              {geminiConnecting
                ? 'Connecting to Gemini Live...'
                : voiceModeActive
                ? engine === 'gemini-live'
                  ? geminiSendMode === 'hands-free'
                    ? `Gemini Live ON (Hands-free · ${geminiVoice}) — speak naturally`
                    : `Gemini Live ON (${geminiVoice}) — speak into the box and press ↑ to send`
                  : `Local Voice ON (${resolvedVoiceModel} · Kokoro-82M) — speak into the box and press ↑`
                : `Voice ready: ${
                    engine === 'gemini-live'
                      ? `Gemini Live (${geminiSendMode === 'hands-free' ? 'Hands-free' : 'Press ↑ to send'})`
                      : 'Local Voice + Chat Model'
                  } · Click the voice icon to talk.`}
            </p>
          </div>
        </div>
      </div>

      {/* Session Manager Dialog */}
      <Dialog open={sessionManagerOpen} onOpenChange={setSessionManagerOpen}>
        <DialogContent className="sm:max-w-[420px] p-0 overflow-hidden bg-[#1c1d20] border-[#2f3136] text-[#e8eaed] rounded-2xl">
          <DialogTitle className="sr-only">Chat Sessions</DialogTitle>
          <SessionManager
            sessions={chat.sessions}
            currentSessionId={chat.currentSessionId ?? null}
            onCreateSession={(title) => chat.createSession(title)}
            onSelectSession={(id) => {
              chat.switchSession(id)
              setSessionManagerOpen(false)
            }}
            onUpdateSession={(sessionId, title) => chat.updateSession(sessionId, { title })}
            onDeleteSession={chat.deleteSession}
            loadingSessions={chat.loadingSessions}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
