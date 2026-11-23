/**
 * DOM-level word-by-word karaoke highlighter for existing rendered Markdown chat messages.
 *
 * Wraps visible text-node words inside a container in lightweight `<span data-ra-word>`
 * elements during active Read Aloud playback, highlights/bolds the active word synced to
 * `audio.currentTime` using explicit inline styles (immune to Tailwind purging & prose
 * specificity), and unwraps all spans cleanly on stop/completion so React's DOM stays clean.
 */

export interface TimedWordEntry {
  word: string
  start: number
  end: number
}

export interface DomWordNode {
  el: HTMLSpanElement
  norm: string
  raw: string
}

export interface ReadAloudDomHandle {
  words: DomWordNode[]
  isConnected: () => boolean
  highlightIndex: (idx: number | null) => void
  cleanup: () => void
}

export function normalizeWordToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function shouldSkipTextNode(node: Text): boolean {
  const parent = node.parentElement
  if (!parent) return true
  if (parent.closest('pre, script, style, svg, button, [data-ra-word]')) return true
  return !node.nodeValue || !node.nodeValue.trim()
}

function applyActiveStyle(el: HTMLSpanElement) {
  el.setAttribute('data-ra-active', 'true')
  el.style.fontWeight = '700'
  el.style.color = '#ffffff'
  el.style.backgroundColor = 'rgba(138, 180, 248, 0.24)'
  el.style.borderRadius = '3px'
  el.style.padding = '0 2px'
  el.style.margin = '0 -2px'
  el.style.transition = 'background-color 75ms ease, color 75ms ease'
}

function clearActiveStyle(el: HTMLSpanElement) {
  el.removeAttribute('data-ra-active')
  el.style.fontWeight = ''
  el.style.color = ''
  el.style.backgroundColor = ''
  el.style.borderRadius = ''
  el.style.padding = ''
  el.style.margin = ''
  el.style.transition = ''
}

/**
 * Wrap each word inside `containerEl` with `<span data-ra-word="i">` and return a
 * handle to bold/unbold words and cleanly restore the original DOM afterward.
 */
export function prepareReadAloudDom(containerEl: HTMLElement): ReadAloudDomHandle {
  const textNodes: Text[] = []
  const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT)
  let current = walker.nextNode()
  while (current) {
    if (current.nodeType === Node.TEXT_NODE && !shouldSkipTextNode(current as Text)) {
      textNodes.push(current as Text)
    }
    current = walker.nextNode()
  }

  const words: DomWordNode[] = []
  const createdSpans: HTMLSpanElement[] = []

  for (const textNode of textNodes) {
    const value = textNode.nodeValue || ''
    const parts = value.match(/(\s+|\S+)/g)
    if (!parts || parts.length === 0) continue

    const frag = document.createDocumentFragment()
    for (const part of parts) {
      if (/^\s+$/.test(part)) {
        frag.appendChild(document.createTextNode(part))
      } else {
        const span = document.createElement('span')
        span.setAttribute('data-ra-word', String(words.length))
        span.textContent = part
        const norm = normalizeWordToken(part)
        words.push({ el: span, norm, raw: part })
        createdSpans.push(span)
        frag.appendChild(span)
      }
    }
    textNode.parentNode?.replaceChild(frag, textNode)
  }

  let activeIdx: number | null = null

  const isConnected = () => createdSpans.length > 0 && createdSpans[0].isConnected

  const highlightIndex = (nextIdx: number | null) => {
    if (nextIdx === activeIdx) return
    if (activeIdx !== null && words[activeIdx]) {
      clearActiveStyle(words[activeIdx].el)
    }
    activeIdx = nextIdx
    if (nextIdx !== null && words[nextIdx]) {
      const el = words[nextIdx].el
      applyActiveStyle(el)
      const rect = el.getBoundingClientRect()
      if (rect.top < 72 || rect.bottom > window.innerHeight - 130) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    }
  }

  const cleanup = () => {
    highlightIndex(null)
    const touchedParents = new Set<Node>()
    for (const span of createdSpans) {
      const parent = span.parentNode
      if (!parent) continue
      touchedParents.add(parent)
      parent.replaceChild(document.createTextNode(span.textContent || ''), span)
    }
    touchedParents.forEach((parent) => {
      if ('normalize' in parent && typeof parent.normalize === 'function') {
        parent.normalize()
      }
    })
  }

  return { words, isConnected, highlightIndex, cleanup }
}

/**
 * Split cleaned speech text into natural sentences without breaking inside filenames
 * (e.g. `GLOSSARY.md`), version numbers (`v1.0`), or decimals (`3.14`).
 */
export function splitIntoSpeechSentences(cleanText: string): string[] {
  const raw = cleanText
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'\[\(\/`])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return raw.length > 0 ? raw : cleanText.trim() ? [cleanText.trim()] : []
}

/**
 * Align Whisper word timestamps for one spoken sentence onto sequential DOM word indices.
 * Uses a generous forward lookahead window so punctuation, inline code (`mattpocock/skills`,
 * `GLOSSARY.md`), symbols (`&` -> "and"), and bracketed citations stay tightly locked.
 */
export function alignSentenceTimingsToDom(
  sentenceText: string,
  whisperWords: TimedWordEntry[],
  domWords: DomWordNode[],
  cursorStart: number,
  fallbackDurationSec: number
): {
  schedule: Array<{ domIdx: number; start: number; end: number }>
  nextCursor: number
} {
  const schedule: Array<{ domIdx: number; start: number; end: number }> = []
  let cursor = cursorStart

  const findNextDomIdx = (normTarget: string, maxLookahead = 20): number => {
    if (!normTarget) return -1
    const limit = Math.min(domWords.length, cursor + maxLookahead)
    for (let i = cursor; i < limit; i++) {
      const cand = domWords[i].norm
      const raw = domWords[i].raw
      if (normTarget === 'and' && raw === '&') {
        return i
      }
      if (!cand) continue
      if (
        cand === normTarget ||
        (normTarget.length >= 3 && cand.startsWith(normTarget)) ||
        (cand.length >= 3 && normTarget.startsWith(cand)) ||
        (normTarget.length >= 4 && cand.includes(normTarget))
      ) {
        return i
      }
    }
    return -1
  }

  if (whisperWords.length > 0) {
    for (const w of whisperWords) {
      const norm = normalizeWordToken(w.word)
      if (!norm) continue
      const matchIdx = findNextDomIdx(norm, 20)
      if (matchIdx !== -1) {
        schedule.push({ domIdx: matchIdx, start: w.start, end: w.end })
        const matchedFull = domWords[matchIdx].norm
        const isPartialCompound =
          matchedFull.length > norm.length + 2 &&
          (matchedFull.startsWith(norm) ||
            (norm.length >= 4 && matchedFull.includes(norm) && !matchedFull.endsWith(norm)))
        cursor = isPartialCompound ? matchIdx : matchIdx + 1
      }
    }
    if (schedule.length > 0) {
      const lastDom = schedule[schedule.length - 1].domIdx
      return { schedule, nextCursor: Math.max(cursor, lastDom + 1) }
    }
  }

  // Graceful fallback: pace sentence words proportionally across fallbackDurationSec
  const tokens = sentenceText.trim().split(/\s+/).filter(Boolean)
  const matchedIndices: number[] = []
  for (const tok of tokens) {
    const norm = normalizeWordToken(tok)
    const idx = findNextDomIdx(norm, 12)
    if (idx !== -1) {
      matchedIndices.push(idx)
      cursor = idx + 1
    }
  }
  if (matchedIndices.length === 0 || fallbackDurationSec <= 0) {
    return { schedule: [], nextCursor: cursor }
  }

  const weights = matchedIndices.map((idx) => {
    const raw = domWords[idx]?.raw || ''
    const syllables = (raw.toLowerCase().match(/[aeiouy]+/g) || []).length
    const pause = /[,;:—–]$/.test(raw) ? 1.5 : 0
    return Math.max(1, syllables * 1.1 + raw.length * 0.1 + pause)
  })
  const totalW = weights.reduce((a, b) => a + b, 0)
  const effectiveDur = Math.max(0.2, fallbackDurationSec * 0.92)
  let acc = 0
  for (let i = 0; i < matchedIndices.length; i++) {
    const start = (acc / totalW) * effectiveDur
    acc += weights[i]
    const end = (acc / totalW) * effectiveDur
    schedule.push({ domIdx: matchedIndices[i], start, end })
  }
  return { schedule, nextCursor: cursor }
}
