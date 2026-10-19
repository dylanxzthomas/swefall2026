import { useEffect, useRef, useState, type RefObject } from 'react'

/** Follow replies without pulling a parent away from the message they are reading. */
export function useConversationScroll(signal: string, active: boolean, end: RefObject<HTMLDivElement>) {
  const nearEnd = useRef(true), last = useRef(signal)
  const [unseen, setUnseen] = useState(false)
  const jump = () => {
    nearEnd.current = true; setUnseen(false)
    end.current?.scrollIntoView({ block: 'end', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }
  useEffect(() => {
    const track = () => {
      const root = document.scrollingElement
      if (!root) return
      nearEnd.current = root.scrollHeight - root.scrollTop - root.clientHeight < 96
      if (nearEnd.current) setUnseen(false)
    }
    window.addEventListener('scroll', track, { passive: true })
    return () => window.removeEventListener('scroll', track)
  }, [])
  useEffect(() => {
    const changed = last.current !== signal
    last.current = signal
    if (!active || !changed) return
    if (!nearEnd.current || document.querySelector('dialog[open]')) { setUnseen(true); return }
    const frame = requestAnimationFrame(() => end.current?.scrollIntoView({ block: 'end', behavior: 'instant' }))
    return () => cancelAnimationFrame(frame)
  }, [signal, active, end])
  return { unseen, jump }
}
