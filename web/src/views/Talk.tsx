import { useEffect, useState } from 'react'
import { ArrowLeft, Play } from '@phosphor-icons/react'
import type { Checkin, Message, Task } from '../../../shared/types'
import { api, fmtDay, fmtTime, isToday } from '../api'
import { useStore } from '../store'
import { Transcript } from '../components/Transcript'
import { Composer } from '../components/Composer'
import { Brief } from '../components/Brief'
import { Button, StatusPill } from '../components/ui'

const kindLabel: Record<Checkin['kind'], string> = {
  morning: 'Morning check-in',
  midday: 'Midday check',
  evening: 'Evening debrief',
  prep: 'Pre-meeting brief',
  adhoc: 'Conversation',
  onboarding: 'First conversation',
}

/** The home screen. The conversation is the whole point, so it is the whole screen. */
export function Talk({ id }: { id?: string }) {
  const { state, thinking, speaking, brainBusy, pending, endCheckin, skipCheckin, startCheckin, navigate } = useStore()
  const live = state?.live ?? null
  const viewingPast = !!id && live?.id !== id
  const [past, setPast] = useState<{ checkin: Checkin; messages: Message[]; tasks: Task[] } | null>(null)
  const [notes, setNotes] = useState<boolean | null>(null)

  useEffect(() => {
    if (!viewingPast) return setPast(null)
    let alive = true
    api
      .checkin(id!)
      .then((d) => alive && setPast(d))
      .catch(() => alive && setPast(null))
    return () => {
      alive = false
    }
  }, [id, viewingPast, state?.now])

  if (!state) return <div className="p-10 text-ink-3">Loading.</div>

  const checkin = viewingPast ? past?.checkin ?? null : live
  const messages = viewingPast ? past?.messages ?? [] : state.messages
  const tasks = viewingPast ? past?.tasks ?? [] : state.tasks
  const script = checkin?.script
  const hasNotes = !!script && (script.points.length > 0 || script.people.length > 0 || script.questions.length > 0 || tasks.length > 0)
  const notesOpen = hasNotes && (notes ?? window.innerWidth >= 1024)
  const canStart = !!checkin && (checkin.status === 'scheduled' || checkin.status === 'prepared')
  const busy = thinking || brainBusy > 0 || state.status.reflecting || !!state.status.preparing
  const mark = speaking ? 'bg-accent ring' : busy ? 'bg-accent breathe' : live ? 'bg-accent' : 'bg-ink-3'

  const now = Date.now()
  const next = [...state.today.checkins, ...state.tomorrow.checkins].find((c) => (c.status === 'scheduled' || c.status === 'prepared') && new Date(c.scheduled_for).getTime() > now - 60_000)
  const mock = state.providers.brain === 'mock'

  return (
    <div className="flex h-full flex-col">
      {checkin && (
        <div className="flex items-center gap-3 border-b border-line px-6 py-3 lg:px-8">
          {viewingPast && (
            <button type="button" className="text-ink-3 hover:text-ink" onClick={() => navigate('#/')} aria-label="Back">
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-medium tracking-tight text-ink">{checkin.title}</div>
            <div className="text-[12.5px] text-ink-3">
              {kindLabel[checkin.kind]} · {isToday(checkin.scheduled_for) ? '' : `${fmtDay(checkin.scheduled_for)} `}
              {fmtTime(checkin.scheduled_for)}
            </div>
          </div>
          {viewingPast && <StatusPill status={checkin.status} />}
          {hasNotes && (
            <Button variant="ghost" size="sm" onClick={() => setNotes(!notesOpen)}>
              {notesOpen ? 'Hide notes' : 'Notes'}
            </Button>
          )}
          {checkin.status === 'live' && (
            <>
              <Button variant="ghost" size="sm" onClick={() => void skipCheckin(checkin.id)}>
                Skip
              </Button>
              <Button variant="primary" size="sm" onClick={() => void endCheckin(checkin.id)}>
                End
              </Button>
            </>
          )}
          {canStart && (
            <Button variant="primary" size="sm" onClick={() => void startCheckin(checkin.id)}>
              <Play size={14} weight="fill" /> Start now
            </Button>
          )}
        </div>
      )}

      <div className={`grid min-h-0 flex-1 grid-cols-1 ${notesOpen ? 'lg:grid-cols-[minmax(0,1fr)_340px]' : ''}`}>
        <div className="flex min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {messages.length === 0 && !pending ? (
              <div className="flex h-full min-h-[280px] flex-col items-center justify-center px-6 text-center">
                <span className={`mb-6 h-3.5 w-3.5 rounded-full ${mark}`} aria-hidden />
                <h1 className="max-w-[22ch] text-[30px] font-medium leading-[1.15] tracking-tight text-ink lg:text-[38px]">{viewingPast ? 'Nothing was said.' : state.status.headline}</h1>
                {!viewingPast && <p className="mt-3 max-w-[46ch] text-[16px] text-ink-2">{state.status.detail}</p>}
                {!viewingPast && !live && next && (
                  <p className="mt-6 text-[13.5px] text-ink-3">
                    Next: {next.title}, {isToday(next.scheduled_for) ? fmtTime(next.scheduled_for) : `tomorrow ${fmtTime(next.scheduled_for)}`}.{' '}
                    <button type="button" className="text-ink-2 underline decoration-line underline-offset-4 hover:text-accent" onClick={() => void startCheckin(next.id)}>
                      Start early
                    </button>
                  </p>
                )}
                {!viewingPast && mock && (
                  <p className="mt-2 text-[13px] text-ink-3">
                    No brain yet. Add <span className="font-mono text-[12px]">ANTHROPIC_API_KEY</span> to .env and restart.
                  </p>
                )}
              </div>
            ) : (
              <div className="mx-auto max-w-[720px] px-6 py-8 lg:px-8">
                <Transcript messages={messages} assistantName={state.assistant.name} userName={state.user.name} thinking={!viewingPast && thinking} pending={viewingPast ? null : pending} />
                {viewingPast && checkin?.summary && <p className="mt-8 border-t border-line pt-4 text-[13.5px] text-ink-2">{checkin.summary}</p>}
              </div>
            )}
          </div>
          {!viewingPast && (
            <div className="px-6 pb-7 pt-3">
              <Composer large={!live} />
            </div>
          )}
        </div>
        {notesOpen && checkin && (
          <aside className="border-t border-line px-6 py-6 lg:overflow-y-auto lg:border-l lg:border-t-0 lg:py-8">
            <Brief checkin={checkin} tasks={tasks} />
          </aside>
        )}
      </div>
    </div>
  )
}
