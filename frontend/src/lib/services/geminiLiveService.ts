import { GoogleGenAI, Modality } from '@google/genai'
import { audioWorkletCode } from '../audio/audioWorkletCode'

export interface LiveTranscriptItem {
  id: string
  role: 'user' | 'model'
  text: string
  isFinal: boolean
  timestamp: Date
}

export interface LiveSessionOptions {
  apiKey: string
  notebookTitle?: string
  documentContext?: string
  notesContext?: string
  language?: string
  voiceName?: string
  model?: string
}

export type LiveSessionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

type Listener = (...args: any[]) => void

class EventEmitter {
  private events: Record<string, Listener[]> = {}

  on(event: string, listener: Listener): () => void {
    if (!this.events[event]) {
      this.events[event] = []
    }
    this.events[event].push(listener)
    return () => this.off(event, listener)
  }

  off(event: string, listener: Listener): void {
    if (!this.events[event]) return
    this.events[event] = this.events[event].filter(l => l !== listener)
  }

  emit(event: string, ...args: any[]): void {
    if (!this.events[event]) return
    this.events[event].forEach(listener => {
      try {
        listener(...args)
      } catch (err) {
        console.error(`Error in event listener for ${event}:`, err)
      }
    })
  }
}

// Base64 audio utilities
export const decodeBase64 = (base64: string): Uint8Array => {
  const binaryString = atob(base64)
  const len = binaryString.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}

export const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export class GeminiLiveService {
  private ai: GoogleGenAI | null = null
  private session: any = null
  private status: LiveSessionStatus = 'disconnected'
  private emitter = new EventEmitter()

  // Audio contexts and worklets
  private inputAudioContext: AudioContext | null = null
  private outputAudioContext: AudioContext | null = null
  private mediaStream: MediaStream | null = null
  private recordingWorkletNode: AudioWorkletNode | null = null
  private playbackWorkletNode: AudioWorkletNode | null = null
  private isMuted = false

  public on = this.emitter.on.bind(this.emitter)
  public off = this.emitter.off.bind(this.emitter)

  public getStatus(): LiveSessionStatus {
    return this.status
  }

  public getIsMuted(): boolean {
    return this.isMuted
  }

  public setMuted(muted: boolean) {
    this.isMuted = muted
    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach(track => {
        track.enabled = !muted
      })
    }
    this.emitter.emit('muteChanged', this.isMuted)
  }

  public async start(options: LiveSessionOptions): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') {
      console.warn('GeminiLiveService: Session already active or connecting.')
      return
    }

    this.setStatus('connecting')

    try {
      if (!options.apiKey) {
        throw new Error('Gemini API key is required.')
      }

      this.ai = new GoogleGenAI({ apiKey: options.apiKey })

      // 1. Setup AudioWorklet and AudioContexts
      await this.initAudioOutput()
      await this.initAudioInput()

      // 2. Build system instructions with Open Notebook context
      const docContext = options.documentContext?.trim() || 'No source documents selected.'
      const notesContext = options.notesContext?.trim() || 'No notes available.'
      const notebookTitle = options.notebookTitle || 'Notebook'
      const lang = options.language || 'English'

      const systemInstruction = `You are an intelligent, conversational research assistant inside Open Notebook for the notebook: "${notebookTitle}".
Your goal is to answer questions, discuss ideas, synthesize concepts, and guide the user based on their notebook documents and notes.

CRITICAL INSTRUCTIONS:
- Ground your answers in the provided DOCUMENT SOURCES and NOTES whenever relevant.
- Be conversational, concise, and natural in spoken dialogue (avoid giant walls of text or markdown tables that sound awkward when spoken).
- If the user interrupts or asks a quick clarification, answer directly and concisely.
- The user is speaking ${lang}. Respond in ${lang}.

NOTEBOOK SOURCES:
---
${docContext}
---

NOTEBOOK NOTES:
---
${notesContext}
---`;

      const config = {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: options.voiceName || 'Kore' }
          }
        },
        systemInstruction,
      }

      const modelName = options.model || 'gemini-3.1-flash-live-preview'
      console.log(`GeminiLiveService: Connecting to ${modelName}...`)

      this.session = await this.ai.live.connect({
        model: modelName,
        callbacks: {
          onopen: () => {
            console.log('GeminiLiveService: Live session WebSocket opened.')
            this.setStatus('connected')
            this.emitter.emit('open')
          },
          onmessage: (msg: any) => this.handleServerMessage(msg),
          onerror: (err: any) => {
            console.error('GeminiLiveService error:', err)
            this.emitter.emit('error', err)
          },
          onclose: (event: any) => {
            console.log('GeminiLiveService closed:', event)
            this.stop()
          }
        },
        config
      })

      this.setStatus('connected')
    } catch (err) {
      console.error('GeminiLiveService failed to start:', err)
      this.setStatus('error')
      this.stop()
      throw err
    }
  }

  private handleServerMessage(message: any) {
    const serverContent = message.serverContent

    // 1. Audio output chunk
    const base64Audio = serverContent?.modelTurn?.parts?.[0]?.inlineData?.data
    if (base64Audio) {
      this.playAudioChunk(decodeBase64(base64Audio))
    }

    // 2. Interruption detection (barge-in)
    if (serverContent?.interrupted) {
      console.log('GeminiLiveService: User interrupted AI playback.')
      this.playbackWorkletNode?.port.postMessage('clear')
      this.emitter.emit('interrupted')
    }

    // 3. User speech transcription
    if (serverContent?.inputTranscription?.text) {
      this.emitter.emit('inputTranscription', {
        text: serverContent.inputTranscription.text,
      })
    }

    // 4. Model speech transcription
    if (serverContent?.outputTranscription?.text) {
      this.emitter.emit('outputTranscription', {
        text: serverContent.outputTranscription.text,
      })
    }

    // 5. Turn complete
    if (serverContent?.turnComplete) {
      this.emitter.emit('turnComplete')
    }
  }

  private async initAudioOutput() {
    if (!this.outputAudioContext || this.outputAudioContext.state === 'closed') {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
      this.outputAudioContext = new AudioCtx({ sampleRate: 24000 })
    }

    if (this.outputAudioContext.state === 'suspended') {
      await this.outputAudioContext.resume()
    }

    // Add AudioWorklet module
    const blob = new Blob([audioWorkletCode], { type: 'application/javascript' })
    const workletUrl = URL.createObjectURL(blob)
    try {
      await this.outputAudioContext.audioWorklet.addModule(workletUrl)
    } finally {
      URL.revokeObjectURL(workletUrl)
    }

    this.playbackWorkletNode = new AudioWorkletNode(this.outputAudioContext, 'streaming-playback-processor')
    this.playbackWorkletNode.connect(this.outputAudioContext.destination)
  }

  private async initAudioInput() {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
    })

    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
    this.inputAudioContext = new AudioCtx({ sampleRate: 16000 })
    if (this.inputAudioContext.state === 'suspended') {
      await this.inputAudioContext.resume()
    }

    const blob = new Blob([audioWorkletCode], { type: 'application/javascript' })
    const workletUrl = URL.createObjectURL(blob)
    try {
      await this.inputAudioContext.audioWorklet.addModule(workletUrl)
    } finally {
      URL.revokeObjectURL(workletUrl)
    }

    const source = this.inputAudioContext.createMediaStreamSource(this.mediaStream)
    this.recordingWorkletNode = new AudioWorkletNode(this.inputAudioContext, 'pcm-recording-processor')

    // Receive 16-bit PCM Int16 ArrayBuffer from worker thread
    this.recordingWorkletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (this.isMuted || this.status !== 'connected' || !this.session) return

      const pcmBytes = new Uint8Array(event.data)
      const base64Audio = encodeBase64(pcmBytes)

      try {
        this.session.sendRealtimeInput({
          audio: {
            data: base64Audio,
            mimeType: 'audio/pcm;rate=16000'
          }
        })
      } catch (e) {
        console.error('Error sending audio input chunk to Gemini:', e)
      }
    }

    source.connect(this.recordingWorkletNode)
  }

  private playAudioChunk(audioBytes: Uint8Array) {
    if (!this.playbackWorkletNode) return

    // Convert Int16 PCM to Float32 [-1.0, 1.0] for Web Audio output
    const pcm16 = new Int16Array(audioBytes.buffer, audioBytes.byteOffset, audioBytes.byteLength / 2)
    const float32 = new Float32Array(pcm16.length)
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768.0
    }

    this.playbackWorkletNode.port.postMessage(float32)
  }

  public stop() {
    console.log('GeminiLiveService: Stopping session and cleaning up resources.')
    try {
      this.session?.close()
    } catch (_) {}
    this.session = null
    this.ai = null

    // Stop microphone tracks
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop())
      this.mediaStream = null
    }

    // Clean up input
    if (this.recordingWorkletNode) {
      this.recordingWorkletNode.disconnect()
      this.recordingWorkletNode = null
    }
    if (this.inputAudioContext && this.inputAudioContext.state !== 'closed') {
      this.inputAudioContext.close().catch(console.error)
      this.inputAudioContext = null
    }

    // Clean up output
    if (this.playbackWorkletNode) {
      this.playbackWorkletNode.port.postMessage('clear')
      this.playbackWorkletNode.disconnect()
      this.playbackWorkletNode = null
    }
    if (this.outputAudioContext && this.outputAudioContext.state !== 'closed') {
      this.outputAudioContext.close().catch(console.error)
      this.outputAudioContext = null
    }

    this.setStatus('disconnected')
    this.emitter.emit('close')
  }

  private setStatus(status: LiveSessionStatus) {
    this.status = status
    this.emitter.emit('statusChanged', status)
  }
}
