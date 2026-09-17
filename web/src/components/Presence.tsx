import { useStore } from '../store'

/** The assistant's presence: a mark that breathes while it thinks and rings while it speaks, plus its own status line. */
export function Presence({ compact = false }: { compact?: boolean }) {
  const { state, thinking, speaking, brainBusy } = useStore()
  if (!state) return null
  const busy = thinking || brainBusy > 0 || state.status.reflecting || !!state.status.preparing
  const live = !!state.live
  const mark = speaking ? 'bg-accent ring' : busy ? 'bg-accent breathe' : live ? 'bg-accent' : 'bg-ink-3'
  return (
    <div className="flex items-start gap-3">
      <span className={`mt-[7px] h-2.5 w-2.5 shrink-0 rounded-full ${mark}`} aria-hidden />
      <div className="min-w-0">
        <div className={`font-medium tracking-tight text-ink ${compact ? 'text-[15px]' : 'text-[22px] leading-tight'}`}>{state.assistant.name}</div>
        <div className={`text-ink-2 ${compact ? 'text-[13px]' : 'mt-1 text-[15px]'}`}>
          {speaking ? 'Speaking.' : thinking ? 'Thinking about what you said.' : state.status.headline}
          {!compact && !speaking && !thinking && <span className="text-ink-3"> {state.status.detail}</span>}
        </div>
      </div>
    </div>
  )
}
