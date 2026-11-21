import React from 'react'

interface GeminiLiveIconProps extends React.SVGProps<SVGSVGElement> {
  className?: string
  circle?: boolean
}

export function GeminiLiveIcon({ className = 'h-5 w-5', circle = false, ...props }: GeminiLiveIconProps) {
  if (circle) {
    return (
      <svg
        viewBox="0 0 32 32"
        fill="none"
        className={className}
        xmlns="http://www.w3.org/2000/svg"
        {...props}
      >
        <circle cx="16" cy="16" r="15" fill="currentColor" />
        <g fill="var(--background, #000)">
          <rect x="9.5" y="13" width="2.5" height="9" rx="1.25" />
          <rect x="14.75" y="10" width="2.5" height="15" rx="1.25" />
          <rect x="20" y="14.5" width="2.5" height="6" rx="1.25" />
          <path d="M22.5 5 Q22.5 9.5 27 9.5 Q22.5 9.5 22.5 14 Q22.5 9.5 18 9.5 Q22.5 9.5 22.5 5 Z" />
        </g>
      </svg>
    )
  }

  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {/* Waveform bars */}
      <rect x="6.5" y="10" width="2.2" height="7" rx="1.1" />
      <rect x="10.9" y="7.5" width="2.2" height="12" rx="1.1" />
      <rect x="15.3" y="11" width="2.2" height="5" rx="1.1" />
      {/* Gemini 4-pointed Sparkle */}
      <path d="M17.5 3.5 Q17.5 7 21 7 Q17.5 7 17.5 10.5 Q17.5 7 14 7 Q17.5 7 17.5 3.5 Z" />
    </svg>
  )
}
