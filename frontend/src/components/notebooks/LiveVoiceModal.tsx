'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { GeminiLiveIcon } from '@/components/common/GeminiLiveIcon'
import {
  GeminiLiveService,
  LiveSessionStatus,
  LiveTranscriptItem,
} from '@/lib/services/geminiLiveService'
import { useCreateNote } from '@/lib/hooks/use-notes'
import { useModels, useModelDefaults } from '@/lib/hooks/use-models'
import {
  useVoiceSettingsStore,
  KOKORO_VOICES,
  EDGE_VOICES,
} from '@/lib/stores/voice-settings-store'
import {
  Mic,
  MicOff,
  PhoneOff,
  Pin,
  VolumeX,
  Loader2,
  ArrowUp,
  Settings,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { toast } from 'sonner'

interface LiveVoiceModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  notebookId: string
  notebookTitle?: string
  documentContext?: string
  notesContext?: string
  onOpenSettings?: () => void
}

const BRIDGE_BASE = 'http://127.0.0.1:8088'
const CODEX_CHAT_URL = `${BRIDGE_BASE}/v1/chat/completions`
const LOCAL_STT_URL = `${BRIDGE_BASE}/v1/audio/transcriptions`
const LOCAL_TTS_URL = `${BRIDGE_BASE}/v1/audio/speech`
const LOCAL_SEARCH_URL = `${BRIDGE_BASE}/v1/search`
const DEFAULT_CODEX_MODEL = 'gpt-6-luna'

export function LiveVoiceModal({
  open,
  onOpenChange,
  notebookId,
  notebookTitle = 'Notebook',
  documentContext = '',
  notesContext = '',
  onOpenSettings,
}: LiveVoiceModalProps) {
  const createNote = useCreateNote()
  const { data: allModels = [] } = useModels()
  const { data: modelDefaults } = useModelDefaults()
  const {
    engine,
    voiceModel,
    kokoroVoice,
    edgeVoice,
    geminiApiKey,
    webSearchEnabled,
    markNoteUnread,
  } = useVoiceSettingsStore()

  // Resolve active LLM for voice chat (follows Open Notebook's Default Chat Model when 'match-chat')
  const defaultChatModelName =
    allModels.find((m) => m.id === modelDefaults?.default_chat_model)?.name || DEFAULT_CODEX_MODEL
  const resolvedVoiceModel =
    voiceModel && voiceModel !== 'match-chat' ? voiceModel : defaultChatModelName

  // Session state
  const [status, setStatus] = useState<LiveSessionStatus>('disconnected')
  const [isMuted, setIsMuted] = useState(false)
  const [isUserSpeaking, setIsUserSpeaking] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [isThinking, setIsThinking] = useState(false)
  const [isAiSpeaking, setIsAiSpeaking] = useState(false)
  const [transcripts, setTranscripts] = useState<LiveTranscriptItem[]>([])
  const [currentInputText, setCurrentInputText] = useState('')
  const [currentOutputText, setCurrentOutputText] = useState('')
  const [showTranscript, setShowTranscript] = useState(false)

  // Refs
  const liveServiceRef = useRef<GeminiLiveService | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioCtxRef = useRef<AudioContext | null>(null)
  const vadTimerRef = useRef<number | null>(null)
  const sessionActiveRef = useRef(false)
  const isMutedRef = useRef(false)
  const isBusyRef = useRef(false)
  const speechDetectedRef = useRef(false)
  const silenceStartRef = useRef<number | null>(null)
  const transcriptsRef = useRef<LiveTranscriptItem[]>([])
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null)
  const ttsAudioUrlRef = useRef<string | null>(null)
  const ttsAbortRef = useRef<AbortController | null>(null)
  const engineRef = useRef(engine)
  const voiceModelRef = useRef(resolvedVoiceModel)
  const kokoroVoiceRef = useRef(kokoroVoice)
  const edgeVoiceRef = useRef(edgeVoice)

  useEffect(() => {
    engineRef.current = engine
  }, [engine])

  useEffect(() => {
    voiceModelRef.current = resolvedVoiceModel
  }, [resolvedVoiceModel])

  useEffect(() => {
    kokoroVoiceRef.current = kokoroVoice
  }, [kokoroVoice])

  useEffect(() => {
    edgeVoiceRef.current = edgeVoice
  }, [edgeVoice])

  useEffect(() => {
    transcriptsRef.current = transcripts
  }, [transcripts])

  useEffect(() => {
    isMutedRef.current = isMuted
  }, [isMuted])

  useEffect(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight
    }
  }, [transcripts, currentInputText, currentOutputText, showTranscript])

  const stopSpeaking = useCallback(() => {
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
  }, [])

  // Helper: clean markdown for natural speech
  const cleanForSpeech = (raw: string) =>
    raw
      .replace(/[*#_`~>]/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()

  // Helper: fetch a single TTS audio blob (Kokoro-82M or Edge Neural)
  const fetchTtsBlob = useCallback(
    async (text: string, signal: AbortSignal): Promise<Blob | null> => {
      const clean = cleanForSpeech(text)
      if (!clean) return null
      const activeEngine = engineRef.current
      const provider = activeEngine === 'local-kokoro' ? 'kokoro' : 'edge'
      const voice =
        activeEngine === 'local-kokoro' ? kokoroVoiceRef.current : edgeVoiceRef.current

      const res = await fetch(LOCAL_TTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, voice, input: clean, speed: 1.0 }),
        signal,
      })
      if (!res.ok) return null
      return await res.blob()
    },
    []
  )

  // Helper: play a single audio blob to completion (abort-safe)
  const playAudioBlob = useCallback((blob: Blob, signal: AbortSignal): Promise<void> => {
    return new Promise((resolve) => {
      if (signal.aborted || !sessionActiveRef.current) {
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

  // Extract earliest speakable phrase from streaming buffer for ultra-low latency
  const popSpeakableChunk = (buffer: string, isFirstChunk: boolean): [string, string] | null => {
    // Sentence boundary (. ! ? followed by space or newline)
    const sentenceMatch = buffer.match(/^([\s\S]*?[.!?])(?:\s+|\n|$)/)
    if (sentenceMatch && sentenceMatch[1].trim().length >= (isFirstChunk ? 12 : 20)) {
      return [sentenceMatch[1].trim(), buffer.slice(sentenceMatch[0].length)]
    }
    // Newline boundary
    const nlIdx = buffer.indexOf('\n')
    if (nlIdx >= (isFirstChunk ? 16 : 24)) {
      return [buffer.slice(0, nlIdx).trim(), buffer.slice(nlIdx + 1)]
    }
    // For the VERY FIRST chunk, also flush on a natural clause break (, ; : —) after ~28 chars
    if (isFirstChunk && buffer.length >= 28) {
      const clauseMatch = buffer.match(/^([\s\S]{24,}?[,;:—–])(?:\s+)/)
      if (clauseMatch) {
        return [clauseMatch[1].trim(), buffer.slice(clauseMatch[0].length)]
      }
    }
    return null
  }

  const startListeningCycleRef = useRef<() => void>(() => {})

  const processAudioBlob = useCallback(
    async (audioBlob: Blob) => {
      if (!sessionActiveRef.current || audioBlob.size < 1500) {
        isBusyRef.current = false
        if (sessionActiveRef.current && !isMutedRef.current) {
          startListeningCycleRef.current()
        }
        return
      }

      isBusyRef.current = true
      setIsUserSpeaking(false)
      setIsTranscribing(true)

      const turnAbort = new AbortController()
      ttsAbortRef.current = turnAbort

      try {
        const sttRes = await fetch(LOCAL_STT_URL, {
          method: 'POST',
          headers: { 'Content-Type': audioBlob.type || 'audio/webm' },
          body: audioBlob,
          signal: turnAbort.signal,
        })

        if (!sttRes.ok) {
          throw new Error(`Local transcription error (${sttRes.status})`)
        }

        const sttData = await sttRes.json()
        const userText = (sttData?.text || '').trim()
        setIsTranscribing(false)

        if (!userText) {
          isBusyRef.current = false
          if (sessionActiveRef.current && !isMutedRef.current) {
            startListeningCycleRef.current()
          }
          return
        }

        const userTurn: LiveTranscriptItem = {
          id: `${Date.now()}-user`,
          role: 'user',
          text: userText,
          isFinal: true,
          timestamp: new Date(),
        }
        setTranscripts((prev) => [...prev, userTurn])

        setIsThinking(true)
        let webBlock = ''
        if (webSearchEnabled) {
          try {
            const searchRes = await fetch(LOCAL_SEARCH_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query: userText, num_results: 4, max_characters: 3000 }),
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
          } catch (e) {
            if ((e as { name?: string })?.name === 'AbortError') return
            console.error('Voice Exa search failed:', e)
          }
        }

        const systemPrompt = `You are a concise, conversational voice research assistant for the notebook "${notebookTitle}".
Answer the user's spoken question directly based on the notebook documents, notes, and any live web search results below.
Keep responses crisp, natural for speech (2-4 short sentences unless asked for detail; avoid markdown tables or bullet clutter).

NOTEBOOK SOURCES:
---
${documentContext.trim() || 'No source documents selected.'}
---

NOTEBOOK NOTES:
---
${notesContext.trim() || 'No notes available.'}
---${webBlock}`

        const historyMessages = [
          { role: 'system', content: systemPrompt },
          ...transcriptsRef.current.slice(-10).map((item) => ({
            role: item.role === 'user' ? 'user' : 'assistant',
            content: item.text,
          })),
          { role: 'user', content: userText },
        ]

        // Stream tokens live from warm codex app-server
        const chatRes = await fetch(CODEX_CHAT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: voiceModelRef.current || DEFAULT_CODEX_MODEL,
            reasoning_effort: 'low',
            messages: historyMessages,
            stream: true,
          }),
          signal: turnAbort.signal,
        })

        if (!chatRes.ok || !chatRes.body) {
          throw new Error(`Codex bridge returned HTTP ${chatRes.status}`)
        }

        // Pipelined audio playback queue: pre-fetches TTS for each phrase in parallel while playing in order!
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
          while (!turnAbort.signal.aborted && sessionActiveRef.current) {
            if (audioQueue.length === 0) {
              if (streamFinished) break
              await new Promise<void>((resolve) => {
                queueNotify = resolve
              })
              continue
            }
            const nextBlobPromise = audioQueue.shift()!
            const blob = await nextBlobPromise
            if (!blob || turnAbort.signal.aborted || !sessionActiveRef.current) continue
            setIsThinking(false)
            setIsAiSpeaking(true)
            await playAudioBlob(blob, turnAbort.signal)
          }
        })()

        // Read SSE token stream live
        const reader = chatRes.body.getReader()
        const decoder = new TextDecoder()
        let sseBuffer = ''
        let fullReply = ''
        let pendingSpeech = ''

        while (!turnAbort.signal.aborted && sessionActiveRef.current) {
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
              setCurrentOutputText(fullReply)

              // Flush speakable phrases immediately as they form!
              let popped = popSpeakableChunk(pendingSpeech, !firstChunkQueued)
              while (popped) {
                const [phrase, rest] = popped
                enqueueSpeakable(phrase)
                pendingSpeech = rest
                popped = popSpeakableChunk(pendingSpeech, !firstChunkQueued)
              }
            } catch {
              // ignore malformed SSE chunk
            }
          }
        }

        // Flush any remaining trailing words
        if (pendingSpeech.trim() && !turnAbort.signal.aborted && sessionActiveRef.current) {
          enqueueSpeakable(pendingSpeech.trim())
        }
        streamFinished = true
        wakeQueue()

        const finalText = fullReply.trim() || 'I did not receive a response from the model.'
        setCurrentOutputText('')
        setTranscripts((prev) => [
          ...prev,
          {
            id: `${Date.now()}-model`,
            role: 'model',
            text: finalText,
            isFinal: true,
            timestamp: new Date(),
          },
        ])

        await playbackPromise
        setIsThinking(false)
        setIsAiSpeaking(false)
        isBusyRef.current = false
        if (sessionActiveRef.current && !isMutedRef.current && !turnAbort.signal.aborted) {
          startListeningCycleRef.current()
        }
      } catch (err: unknown) {
        if ((err as { name?: string })?.name === 'AbortError') {
          setIsTranscribing(false)
          setIsThinking(false)
          setIsAiSpeaking(false)
          setCurrentOutputText('')
          isBusyRef.current = false
          return
        }
        console.error('Voice pipeline error:', err)
        setIsTranscribing(false)
        setIsThinking(false)
        setIsAiSpeaking(false)
        setCurrentOutputText('')
        isBusyRef.current = false
        toast.error(`Voice error: ${(err as Error)?.message || 'Check local Codex bridge'}`)
        if (sessionActiveRef.current && !isMutedRef.current) {
          startListeningCycleRef.current()
        }
      }
    },
    [notebookTitle, documentContext, notesContext, webSearchEnabled, fetchTtsBlob, playAudioBlob]
  )

  const finishCurrentRecording = useCallback(() => {
    if (vadTimerRef.current) {
      window.clearInterval(vadTimerRef.current)
      vadTimerRef.current = null
    }
    const rec = mediaRecorderRef.current
    if (rec && rec.state === 'recording') {
      rec.stop()
    }
  }, [])

  const startListeningCycle = useCallback(() => {
    const stream = mediaStreamRef.current
    if (!stream || !sessionActiveRef.current || isMutedRef.current || isBusyRef.current) return

    audioChunksRef.current = []
    speechDetectedRef.current = false
    silenceStartRef.current = null
    setIsUserSpeaking(false)

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
      if (vadTimerRef.current) {
        window.clearInterval(vadTimerRef.current)
        vadTimerRef.current = null
      }
      const chunks = audioChunksRef.current
      audioChunksRef.current = []
      if (!sessionActiveRef.current || !speechDetectedRef.current || chunks.length === 0) {
        setIsUserSpeaking(false)
        if (sessionActiveRef.current && !isMutedRef.current && !isBusyRef.current) {
          setTimeout(() => startListeningCycleRef.current(), 150)
        }
        return
      }
      const blob = new Blob(chunks, { type: mimeType || 'audio/webm' })
      processAudioBlob(blob)
    }

    mediaRecorderRef.current = recorder
    recorder.start(250)

    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      audioCtxRef.current = new AudioCtx()
    }
    const ctx = audioCtxRef.current
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {})
    }
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)
    const dataArray = new Uint8Array(analyser.fftSize)

    const SPEECH_THRESHOLD = 0.022
    const SILENCE_MS = 900

    vadTimerRef.current = window.setInterval(() => {
      if (!sessionActiveRef.current || isMutedRef.current || isBusyRef.current) return
      analyser.getByteTimeDomainData(dataArray)
      let sumSq = 0
      for (let i = 0; i < dataArray.length; i++) {
        const v = (dataArray[i] - 128) / 128
        sumSq += v * v
      }
      const rms = Math.sqrt(sumSq / dataArray.length)

      if (rms > SPEECH_THRESHOLD) {
        speechDetectedRef.current = true
        silenceStartRef.current = null
        setIsUserSpeaking(true)
      } else if (speechDetectedRef.current) {
        if (silenceStartRef.current === null) {
          silenceStartRef.current = Date.now()
        } else if (Date.now() - silenceStartRef.current >= SILENCE_MS) {
          finishCurrentRecording()
        }
      }
    }, 100)
  }, [processAudioBlob, finishCurrentRecording])

  useEffect(() => {
    startListeningCycleRef.current = startListeningCycle
  }, [startListeningCycle])

  const startLocalVoice = useCallback(async () => {
    setStatus('connecting')

    try {
      const health = await fetch(`${BRIDGE_BASE}/health`)
      if (!health.ok) throw new Error('Bridge unreachable')
    } catch {
      setStatus('error')
      toast.error('Local voice bridge is not running on port 8088.')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      if (!sessionActiveRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      mediaStreamRef.current = stream
      isBusyRef.current = false
      setIsMuted(false)
      setStatus('connected')
      startListeningCycle()
    } catch (err: unknown) {
      setStatus('error')
      toast.error('Microphone access denied: ' + ((err as Error)?.message || 'Allow mic permission'))
    }
  }, [startListeningCycle])

  const startGeminiLiveVoice = useCallback(async () => {
    const keyToUse =
      geminiApiKey ||
      (typeof window !== 'undefined' ? localStorage.getItem('gemini_api_key') : '') ||
      process.env.NEXT_PUBLIC_GEMINI_API_KEY ||
      ''
    if (!keyToUse) {
      setStatus('error')
      toast.error('Add your Gemini API key in the top-right Settings gear to use Gemini Live.')
      return
    }

    if (!liveServiceRef.current) {
      liveServiceRef.current = new GeminiLiveService()
    }

    const service = liveServiceRef.current
    service.on('statusChanged', (newStatus: LiveSessionStatus) => setStatus(newStatus))
    service.on('muteChanged', (muted: boolean) => setIsMuted(muted))
    service.on('inputTranscription', (data: { text: string }) => {
      setCurrentInputText((prev) => prev + data.text)
    })
    service.on('outputTranscription', (data: { text: string }) => {
      setIsAiSpeaking(true)
      setCurrentOutputText((prev) => prev + data.text)
    })
    service.on('interrupted', () => setIsAiSpeaking(false))
    service.on('turnComplete', () => {
      setIsAiSpeaking(false)
      setCurrentInputText((prevInput) => {
        if (prevInput.trim()) {
          setTranscripts((prev) => [
            ...prev,
            {
              id: `${Date.now()}-user`,
              role: 'user',
              text: prevInput.trim(),
              isFinal: true,
              timestamp: new Date(),
            },
          ])
        }
        return ''
      })
      setCurrentOutputText((prevOutput) => {
        if (prevOutput.trim()) {
          setTranscripts((prev) => [
            ...prev,
            {
              id: `${Date.now()}-model`,
              role: 'model',
              text: prevOutput.trim(),
              isFinal: true,
              timestamp: new Date(),
            },
          ])
        }
        return ''
      })
    })
    service.on('error', (err: unknown) => {
      toast.error('Live voice error: ' + ((err as Error)?.message || 'Connection lost'))
      setStatus('error')
    })

    try {
      await service.start({
        apiKey: keyToUse,
        notebookTitle,
        documentContext,
        notesContext,
        model: 'gemini-3.1-flash-live-preview',
        voiceName: 'Kore',
      })
    } catch (err: unknown) {
      toast.error('Failed to connect: ' + ((err as Error)?.message || 'Check your API key'))
      setStatus('error')
    }
  }, [geminiApiKey, notebookTitle, documentContext, notesContext])

  const handleStopSession = useCallback(() => {
    sessionActiveRef.current = false
    isBusyRef.current = false
    speechDetectedRef.current = false
    stopSpeaking()

    if (vadTimerRef.current) {
      window.clearInterval(vadTimerRef.current)
      vadTimerRef.current = null
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

    if (liveServiceRef.current) {
      liveServiceRef.current.stop()
      liveServiceRef.current = null
    }

    setStatus('disconnected')
    setIsUserSpeaking(false)
    setIsTranscribing(false)
    setIsThinking(false)
    setIsAiSpeaking(false)
    setCurrentInputText('')
    setCurrentOutputText('')
  }, [stopSpeaking])

  // Auto-start immediately when opened; clean up when closed
  useEffect(() => {
    if (open) {
      sessionActiveRef.current = true
      if (engineRef.current === 'gemini-live') {
        startGeminiLiveVoice()
      } else {
        startLocalVoice()
      }
    } else {
      handleStopSession()
    }
    return () => {
      handleStopSession()
    }
  }, [open, startLocalVoice, startGeminiLiveVoice, handleStopSession])

  const handleToggleMute = () => {
    const nextMute = !isMuted
    setIsMuted(nextMute)
    isMutedRef.current = nextMute

    if (engine === 'gemini-live' && liveServiceRef.current) {
      liveServiceRef.current.setMuted(nextMute)
    } else if (engine !== 'gemini-live') {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getAudioTracks().forEach((t) => {
          t.enabled = !nextMute
        })
      }
      if (!nextMute && !isBusyRef.current && mediaRecorderRef.current?.state !== 'recording') {
        startListeningCycle()
      }
    }
  }

  const handleManualSend = () => {
    if (engine !== 'gemini-live' && mediaRecorderRef.current?.state === 'recording') {
      speechDetectedRef.current = true
      finishCurrentRecording()
    }
  }

  const handleInterruptSpeech = () => {
    stopSpeaking()
    isBusyRef.current = false
    if (sessionActiveRef.current && !isMutedRef.current) {
      startListeningCycle()
    }
  }

  const handleSaveAsNote = async () => {
    if (transcripts.length === 0) {
      toast.info('No conversation turns to save yet.')
      return
    }
    const speakerLabel = engine !== 'gemini-live' ? 'Luna' : 'Gemini'
    const firstTopic = transcripts[0]?.text?.slice(0, 56) || notebookTitle
    const title = `Voice Note: ${firstTopic}${firstTopic.length >= 56 ? '...' : ''}`
    const markdownContent = transcripts
      .map((t) => `**${t.role === 'user' ? 'You' : speakerLabel}**: ${t.text}`)
      .join('\n\n')

    try {
      const created = await createNote.mutateAsync({
        notebook_id: notebookId,
        title,
        content: markdownContent,
        note_type: 'ai',
      })
      if (created?.id) markNoteUnread(created.id)
      toast.success('Voice conversation saved to Studio notes!')
    } catch {
      toast.error('Failed to save note')
    }
  }

  const assistantName = engine !== 'gemini-live' ? 'Assistant' : 'Gemini'
  const activeVoiceLabel =
    engine === 'local-kokoro'
      ? `${resolvedVoiceModel} · Kokoro · ${KOKORO_VOICES.find((v) => v.id === kokoroVoice)?.label.split(' ')[0] || 'Heart'}`
      : engine === 'openai-edge'
      ? `${resolvedVoiceModel} · Edge · ${EDGE_VOICES.find((v) => v.id === edgeVoice)?.label.split(' ')[0] || 'Ava'}`
      : 'Gemini Live'

  const statusText =
    status === 'connecting'
      ? 'Connecting...'
      : status === 'error'
      ? 'Connection unavailable'
      : isTranscribing
      ? 'Listening...'
      : isThinking
      ? `${assistantName} is thinking...`
      : isAiSpeaking
      ? `${assistantName} is speaking`
      : isMuted
      ? 'Microphone muted'
      : isUserSpeaking
      ? 'Hearing you...'
      : 'Listening'

  const lastTurn = transcripts[transcripts.length - 1]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px] p-0 overflow-hidden bg-[#0e0f13] border border-[#282a31] text-[#e8eaed] rounded-[28px] shadow-2xl">
        <DialogTitle className="sr-only">Live Voice Mode</DialogTitle>

        {/* Minimal Top Bar */}
        <div className="px-5 pt-4 pb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-[#9aa0a6]">
            <span
              className={`h-2 w-2 rounded-full ${
                status === 'connected'
                  ? 'bg-emerald-400'
                  : status === 'error'
                  ? 'bg-red-400'
                  : 'bg-amber-400'
              }`}
            />
            <span className="font-medium text-[#c4c7c5]">{activeVoiceLabel}</span>
          </div>
          {onOpenSettings && (
            <button
              type="button"
              onClick={() => {
                onOpenChange(false)
                onOpenSettings()
              }}
              className="p-1.5 mr-6 rounded-full text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#1e2026] transition-colors"
              title="Voice Settings"
            >
              <Settings className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Clean Gemini-Style Center Orb */}
        <div className="px-6 pt-8 pb-6 flex flex-col items-center justify-center relative">
          {/* Soft ambient radial glow (CSS-only, low GPU load) */}
          <div
            className="relative flex items-center justify-center w-44 h-44"
          >
            <div
              className={`absolute inset-0 rounded-full blur-2xl transition-all duration-700 ${
                isAiSpeaking
                  ? 'bg-gradient-to-tr from-[#4285f4]/45 via-[#8b5cf6]/40 to-[#38bdf8]/45 scale-110 opacity-100'
                  : isUserSpeaking
                  ? 'bg-gradient-to-tr from-[#34d399]/35 via-[#38bdf8]/35 to-[#4285f4]/35 scale-105 opacity-95'
                  : isThinking || isTranscribing
                  ? 'bg-gradient-to-tr from-[#6366f1]/35 via-[#a855f7]/30 to-[#3b82f6]/35 scale-100 opacity-90'
                  : isMuted
                  ? 'bg-[#2a2c32]/30 scale-90 opacity-50'
                  : 'bg-gradient-to-tr from-[#4285f4]/25 via-[#6366f1]/20 to-[#38bdf8]/25 scale-95 opacity-80'
              }`}
            />

            {/* Sleek Core Circle */}
            <div
              className={`relative z-10 w-24 h-24 rounded-full flex items-center justify-center transition-all duration-500 border ${
                isAiSpeaking
                  ? 'bg-gradient-to-br from-[#3b82f6] via-[#6366f1] to-[#8b5cf6] border-white/25 text-white scale-105 shadow-[0_0_40px_rgba(99,102,241,0.45)]'
                  : isUserSpeaking
                  ? 'bg-gradient-to-br from-[#10b981] to-[#3b82f6] border-white/25 text-white scale-105 shadow-[0_0_32px_rgba(16,185,129,0.35)]'
                  : isMuted
                  ? 'bg-[#1c1d22] border-[#32343a] text-[#9aa0a6]'
                  : 'bg-gradient-to-br from-[#1b2234] to-[#161925] border-[#4285f4]/40 text-[#a8c7fa] shadow-[0_0_24px_rgba(66,133,244,0.2)]'
              }`}
            >
              {isThinking || isTranscribing || status === 'connecting' ? (
                <Loader2 className="h-9 w-9 animate-spin text-[#a8c7fa]" />
              ) : (
                <GeminiLiveIcon className="h-11 w-11" />
              )}
            </div>
          </div>

          <p className="mt-4 text-[16px] font-medium tracking-tight text-[#e8eaed]">
            {statusText}
          </p>
          <p className="mt-1 text-xs text-[#9aa0a6] max-w-[300px] truncate text-center">
            {notebookTitle}
          </p>

          {/* Subtle Live Caption / Collapsible Transcript */}
          {(lastTurn || currentInputText || currentOutputText) && (
            <div className="mt-5 w-full">
              <button
                type="button"
                onClick={() => setShowTranscript((prev) => !prev)}
                className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] text-[#9aa0a6] hover:text-[#e8eaed] transition-colors"
              >
                <span>{showTranscript ? 'Hide transcript' : 'Live caption'}</span>
                {showTranscript ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>

              {showTranscript ? (
                <div
                  ref={scrollAreaRef}
                  className="max-h-36 overflow-y-auto px-3 py-2 rounded-2xl bg-[#16171c] border border-[#262830] space-y-2 text-xs"
                >
                  {transcripts.map((item) => (
                    <div
                      key={item.id}
                      className={item.role === 'user' ? 'text-[#a8c7fa]' : 'text-[#dcdfe4]'}
                    >
                      <span className="font-semibold mr-1.5 opacity-75">
                        {item.role === 'user' ? 'You:' : `${assistantName}:`}
                      </span>
                      {item.text}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="px-3 py-2 rounded-2xl bg-[#16171c] border border-[#24262e] text-xs text-[#c4c7c5] line-clamp-2 text-center leading-relaxed">
                  {currentOutputText || currentInputText || lastTurn?.text}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Clean Gemini-Style Bottom Control Bar */}
        <div className="px-6 pb-6 pt-2 flex items-center justify-center gap-3.5">
          {/* Mute / Unmute */}
          <button
            type="button"
            onClick={handleToggleMute}
            className={`h-12 w-12 rounded-full flex items-center justify-center transition-colors ${
              isMuted
                ? 'bg-[#e8eaed] text-[#0e0f13]'
                : 'bg-[#22242a] hover:bg-[#2d3038] text-[#e8eaed]'
            }`}
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>

          {/* Interrupt when AI speaks, or Send Now when user is speaking */}
          {engine !== 'gemini-live' && isAiSpeaking && (
            <button
              type="button"
              onClick={handleInterruptSpeech}
              className="h-12 w-12 rounded-full bg-[#22242a] hover:bg-[#2d3038] text-[#e8eaed] flex items-center justify-center transition-colors"
              title="Interrupt & speak"
            >
              <VolumeX className="h-5 w-5" />
            </button>
          )}

          {engine !== 'gemini-live' && !isAiSpeaking && isUserSpeaking && (
            <button
              type="button"
              onClick={handleManualSend}
              className="h-12 w-12 rounded-full bg-[#4285f4] hover:bg-[#5a95f5] text-white flex items-center justify-center transition-colors"
              title="Send now"
            >
              <ArrowUp className="h-5 w-5" />
            </button>
          )}

          {/* Save conversation to Studio note */}
          {transcripts.length > 0 && (
            <button
              type="button"
              onClick={handleSaveAsNote}
              className="h-12 w-12 rounded-full bg-[#22242a] hover:bg-[#2d3038] text-[#e8eaed] flex items-center justify-center transition-colors"
              title="Save transcript to Studio note"
            >
              <Pin className="h-5 w-5" />
            </button>
          )}

          {/* End Call */}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-12 w-14 rounded-full bg-[#ea4335] hover:bg-[#f2584b] text-white flex items-center justify-center transition-colors shadow-lg"
            title="End voice chat"
          >
            <PhoneOff className="h-5 w-5" />
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
