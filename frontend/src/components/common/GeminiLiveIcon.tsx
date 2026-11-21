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
        <g
          stroke="var(--background, #000)"
          strokeWidth="2.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M8 14.5v3" />
          <path d="M11.2 11.5v9" />
          <path d="M14.4 9v14" />
          <path d="M17.6 13v6" />
          <path d="M20.8 10.5v11" />
          <path d="M24 14.5v3" />
        </g>
      </svg>
    )
  }

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {/* Clean AudioLines waveform */}
      <path d="M2 10v3" />
      <path d="M6 6v11" />
      <path d="M10 3v18" />
      <path d="M14 8v7" />
      <path d="M18 5v13" />
      <path d="M22 10v3" />
    </svg>
  )
}
