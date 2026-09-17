import { ArrowRight, Play } from '@phosphor-icons/react'
import type { CalEvent, Checkin } from '../../../shared/types'
import { fmtTime } from '../api'
import { useStore } from '../store'
import { Button, StatusPill } from './ui'

type Item = { kind: 'checkin'; at: string; checkin: Checkin } | { kind: 'event'; at: string; event: CalEvent }

export function mergeTimeline(checkins: Checkin[], events: CalEvent[]): Item[] {
  const items: Item[] = [
    ...checkins.map((c) => ({ kind: 'checkin' as const, at: c.scheduled_for, checkin: c })),
    ...events.map((e) => ({ kind: 'event' as const, at: e.start, event: e })),
  ]
  return items.sort((a, b) => a.at.localeCompare(b.at))
}

export function Timeline({ checkins, events, compact = false }: { checkins: Checkin[]; events: CalEvent[]; compact?: boolean }) {
  const { startCheckin, navigate } = useStore()
  const items = mergeTimeline(checkins, events)
  if (!items.length) return <p className="text-[14px] text-ink-3">Nothing on the calendar.</p>
  const now = Date.now()
  return (
    <ol className="flex flex-col">
      {items.map((it) => {
        const past = new Date(it.at).getTime() < now && !(it.kind === 'checkin' && it.checkin.status === 'live')
        if (it.kind === 'event') {
          const e = it.event
          return (
            <li key={`e-${e.id}`} className={`flex items-baseline gap-3 py-2 ${compact ? '' : 'border-b border-line last:border-0'} ${past ? 'opacity-50' : ''}`}>
              <span className="w-16 shrink-0 font-mono text-[12.5px] text-ink-3">{e.all_day ? 'all day' : fmtTime(e.start)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14.5px] text-ink">{e.title}</span>
                {!compact && e.attendees.length > 0 && <span className="block truncate text-[13px] text-ink-3">with {e.attendees.map((a) => a.name).join(', ')}</span>}
              </span>
            </li>
          )
        }
        const c = it.checkin
        const canStart = c.status === 'scheduled' || c.status === 'prepared'
        return (
          <li key={`c-${c.id}`} className={`flex items-center gap-3 py-2 ${compact ? '' : 'border-b border-line last:border-0'} ${past && !canStart ? 'opacity-60' : ''}`}>
            <span className="w-16 shrink-0 font-mono text-[12.5px] text-ink-3">{fmtTime(c.scheduled_for)}</span>
            <span className="min-w-0 flex-1">
              <button type="button" onClick={() => navigate(`#/meeting/${c.id}`)} className="block max-w-full truncate text-left text-[14.5px] font-medium text-ink hover:text-accent">
                {c.title}
              </button>
              {!compact && c.summary && <span className="block truncate text-[13px] text-ink-3">{c.summary}</span>}
            </span>
            {!compact && <StatusPill status={c.status} />}
            {canStart && (
              <Button size="sm" variant="ghost" onClick={() => void startCheckin(c.id)} title="Start this conversation now">
                <Play size={14} weight="fill" /> Start
              </Button>
            )}
            {c.status === 'live' && (
              <Button size="sm" variant="primary" onClick={() => navigate('#/')}>
                Open <ArrowRight size={14} />
              </Button>
            )}
          </li>
        )
      })}
    </ol>
  )
}
