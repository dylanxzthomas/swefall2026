import { useEffect, useRef, useState } from 'react'
import { Microphone, PaperPlaneRight, Stop } from '@phosphor-icons/react'
import { useRecorder } from '../recorder'
import { useStore } from '../store'

/** The one control that matters: hold to talk. Works whether or not a conversation is open. */
export function Composer({ large = false }: { large?: boolean }) {
  const { state, say, thinking, speaking, stopAudio } = useStore()
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const serverStt = state?.providers.stt !== 'browser'
  const rec = useRecorder(serverStt, (t) => void send(t, 'voice'))
  const name = state?.assistant.name ?? 'Wren'

  const send = async (t: string, via: 'voice' | 'text') => {
    const v = t.trim()
    if (!v) return
    setText('')
    setErr(null)
    try {
      await say(v, via)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  // Hold Space to talk when nothing is focused.
  useEffect(() => {
    const isTyping = () => {
      const el = document.activeElement
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement | null)?.isContentEditable
    }
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !isTyping() && !rec.recording) {
        e.preventDefault()
        stopAudio()
        void rec.start()
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space' && rec.recording) {
        e.preventDefault()
        rec.stop()
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [rec, stopAudio])

  const value = rec.interim || text
  useEffect(() => {
    const el = ta.current
    if (!el) return
    if (!value) {
      el.style.height = ''
      return
    }
    el.style.height = '0px'
    el.style.height = `${Math.min(140, el.scrollHeight)}px`
  }, [value])

  const status = rec.recording
    ? 'Listening. Let go to send.'
    : rec.transcribing
      ? 'Working out what you said.'
      : thinking
        ? `${name} is thinking.`
        : speaking
          ? `${name} is speaking. Hold to cut in.`
          : rec.mode === 'none'
            ? 'No microphone in this browser. Type below.'
            : 'Hold to talk. Or hold Space.'

  const size = large ? 'h-24 w-24' : 'h-16 w-16'
  const icon = large ? 34 : 24

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col items-center gap-3">
      <button
        type="button"
        aria-label="Hold to talk"
        disabled={rec.mode === 'none'}
        onPointerDown={(e) => {
          e.preventDefault()
          stopAudio()
          void rec.start()
        }}
        onPointerUp={() => rec.stop()}
        onPointerLeave={() => rec.recording && rec.stop()}
        onPointerCancel={() => rec.stop()}
        className={`flex ${size} shrink-0 select-none items-center justify-center rounded-full border transition active:scale-[0.97] disabled:opacity-40 ${
          rec.recording ? 'border-accent bg-accent text-accent-ink ring' : 'border-line-2 bg-paper-2 text-ink hover:border-accent hover:text-accent'
        }`}
      >
        {rec.recording ? <Stop size={icon} weight="fill" /> : <Microphone size={icon} weight="regular" />}
      </button>
      <div className="h-5 text-[13px] text-ink-3">{err || rec.error ? <span className="text-danger">{err || rec.error}</span> : status}</div>
      <div className="flex w-full max-w-[560px] items-end gap-2 rounded-[24px] border border-line bg-paper-2 py-1.5 pl-4 pr-1.5 focus-within:border-accent">
        <textarea
          ref={ta}
          rows={1}
          value={value}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send(text, 'text')
            }
          }}
          placeholder="Or type."
          className="max-h-36 min-h-[24px] flex-1 resize-none bg-transparent text-[15px] leading-relaxed text-ink outline-none placeholder:text-ink-3"
        />
        <button type="button" aria-label="Send" onClick={() => void send(text, 'text')} disabled={!text.trim()} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition active:scale-[0.97] disabled:opacity-30">
          <PaperPlaneRight size={14} weight="fill" />
        </button>
      </div>
    </div>
  )
}
