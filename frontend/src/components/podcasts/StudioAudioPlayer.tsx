'use client'

import { useEffect, useRef, useState } from 'react'
import { Pause, Play, Volume2, VolumeX, Download } from 'lucide-react'

function SkipBack5Icon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <text
        x="12"
        y="15.3"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontSize="8.5"
        fontWeight="700"
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        5
      </text>
    </svg>
  )
}

function SkipForward5Icon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <text
        x="12"
        y="15.3"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontSize="8.5"
        fontWeight="700"
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        5
      </text>
    </svg>
  )
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const total = Math.floor(sec)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

const SPEED_STEPS = [1, 1.25, 1.5, 1.75, 2]

interface StudioAudioPlayerProps {
  src: string
  autoPlay?: boolean
  downloadFilename?: string
}

export function StudioAudioPlayer({
  src,
  autoPlay = false,
  downloadFilename,
}: StudioAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isMuted, setIsMuted] = useState(false)
  const [speedIndex, setSpeedIndex] = useState(0)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.playbackRate = SPEED_STEPS[speedIndex]
  }, [speedIndex, src])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    setCurrentTime(0)
    setDuration(0)
    if (autoPlay) {
      audio.play().catch(() => {
        setIsPlaying(false)
      })
    }
  }, [src, autoPlay])

  const togglePlay = () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      audio.play().catch(() => {})
    } else {
      audio.pause()
    }
  }

  const skipBy = (deltaSec: number) => {
    const audio = audioRef.current
    if (!audio) return
    const maxTime = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Infinity
    const next = Math.min(maxTime, Math.max(0, audio.currentTime + deltaSec))
    audio.currentTime = next
    setCurrentTime(next)
  }

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current
    if (!audio) return
    const next = Number(e.target.value)
    audio.currentTime = next
    setCurrentTime(next)
  }

  const toggleMute = () => {
    const audio = audioRef.current
    if (!audio) return
    audio.muted = !audio.muted
    setIsMuted(audio.muted)
  }

  const cycleSpeed = () => {
    setSpeedIndex((prev) => (prev + 1) % SPEED_STEPS.length)
  }

  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0

  return (
    <div
      className="w-full rounded-xl bg-[#141519] border border-[#2c2f38] px-2.5 py-2 space-y-1.5"
      onClick={(e) => e.stopPropagation()}
    >
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime || 0)}
      />

      {/* Top row: -5s, Play/Pause, +5s, Time, Speed, Mute, Download */}
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => skipBy(-5)}
            title="Rewind 5 seconds"
            aria-label="Rewind 5 seconds"
            className="h-7 w-7 rounded-full flex items-center justify-center text-[#c4c7c5] hover:text-white hover:bg-[#252830] transition-colors"
          >
            <SkipBack5Icon className="h-[18px] w-[18px]" />
          </button>

          <button
            type="button"
            onClick={togglePlay}
            title={isPlaying ? 'Pause' : 'Play'}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            className="h-7 w-7 rounded-full flex items-center justify-center bg-[#8ab4f8] hover:bg-[#a6c8ff] text-[#0f1115] transition-colors"
          >
            {isPlaying ? (
              <Pause className="h-3.5 w-3.5 fill-current" />
            ) : (
              <Play className="h-3.5 w-3.5 fill-current ml-0.5" />
            )}
          </button>

          <button
            type="button"
            onClick={() => skipBy(5)}
            title="Forward 5 seconds"
            aria-label="Forward 5 seconds"
            className="h-7 w-7 rounded-full flex items-center justify-center text-[#c4c7c5] hover:text-white hover:bg-[#252830] transition-colors"
          >
            <SkipForward5Icon className="h-[18px] w-[18px]" />
          </button>

          <span className="ml-1 font-mono text-[11px] text-[#9aa0a6] tabular-nums select-none">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
        </div>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={cycleSpeed}
            title="Playback speed"
            aria-label="Playback speed"
            className="h-6 px-1.5 rounded text-[10.5px] font-mono text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#252830] transition-colors"
          >
            {SPEED_STEPS[speedIndex]}x
          </button>

          <button
            type="button"
            onClick={toggleMute}
            title={isMuted ? 'Unmute' : 'Mute'}
            aria-label={isMuted ? 'Unmute' : 'Mute'}
            className="h-6 w-6 rounded flex items-center justify-center text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#252830] transition-colors"
          >
            {isMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          </button>

          {downloadFilename && (
            <a
              href={src}
              download={downloadFilename}
              title="Download MP3"
              aria-label="Download MP3"
              className="h-6 w-6 rounded flex items-center justify-center text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#252830] transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </div>

      {/* Scrubbable progress bar */}
      <div className="relative flex items-center h-3">
        <div className="w-full h-1.5 rounded-full bg-[#2a2d36] overflow-hidden">
          <div
            className="h-full bg-[#8ab4f8] rounded-full transition-[width] duration-75"
            style={{ width: `${pct}%` }}
          />
        </div>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={currentTime}
          onChange={handleSeek}
          aria-label="Seek audio"
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
      </div>
    </div>
  )
}
