import { useEffect, useRef } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { SpeakerHigh } from '@phosphor-icons/react'
import type { Message } from '../../../shared/types'
import { fmtTime } from '../api'
import { useStore, type Pending } from '../store'

export function Transcript({ messages, assistantName, userName, thinking, pending }: { messages: Message[]; assistantName: string; userName: string; thinking: boolean; pending?: Pending | null }) {
  const { play } = useStore()
  const end = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'end' })
  }, [messages.length, thinking, pending, reduce])
  return (
    <div className="flex flex-col gap-6">
      {messages.map((m) => (
        <motion.div key={m.id} initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }} className={`flex flex-col gap-1 ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
          <div className="flex items-center gap-2 text-[12px] text-ink-3">
            <span className="font-medium text-ink-2">{m.role === 'user' ? userName : assistantName}</span>
            <span className="font-mono">{fmtTime(m.created_at)}</span>
            {m.role === 'assistant' && m.audio_path && (
              <button type="button" className="text-ink-3 hover:text-accent" title="Play again" onClick={() => void play(`/audio/${m.audio_path!.split('/').pop()}`)}>
                <SpeakerHigh size={14} />
              </button>
            )}
          </div>
          <p className={`max-w-[62ch] whitespace-pre-wrap text-[16px] leading-relaxed ${m.role === 'user' ? 'rounded-card border border-line bg-paper-2 px-4 py-2.5 text-ink' : 'text-ink'}`}>{m.text}</p>
        </motion.div>
      ))}
      {pending && (
        <div className="flex flex-col items-end gap-1 opacity-70">
          <div className="text-[12px] font-medium text-ink-2">{userName}</div>
          <p className="max-w-[62ch] whitespace-pre-wrap rounded-card border border-line bg-paper-2 px-4 py-2.5 text-[16px] leading-relaxed text-ink">{pending.text}</p>
        </div>
      )}
      {thinking && (
        <div className="flex items-center gap-2 text-[13px] text-ink-3">
          <span className="h-2 w-2 rounded-full bg-accent breathe" /> {assistantName} is thinking
        </div>
      )}
      <div ref={end} />
    </div>
  )
}
