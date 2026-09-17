import { Play, X } from '@phosphor-icons/react'
import { api, fmtTime, isToday } from '../api'
import { useStore } from '../store'
import { Timeline } from '../components/Timeline'
import { Button, Card, Empty, Evidence, SectionTitle, StatusPill } from '../components/ui'

export function Schedule() {
  const { state, startCheckin, refresh } = useStore()
  if (!state) return <div className="p-10 text-ink-3">Loading.</div>
  const now = Date.now()
  const next = [...state.today.checkins, ...state.tomorrow.checkins].find((c) => (c.status === 'scheduled' || c.status === 'prepared') && new Date(c.scheduled_for).getTime() > now - 60_000)
  const mock = state.providers.brain === 'mock'

  return (
    <div className="mx-auto max-w-[880px] px-6 py-8 lg:px-10 lg:py-12">
      <p className="text-[13px] text-ink-3">{new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      <h1 className="mt-1 text-[28px] font-medium leading-tight tracking-tight text-ink">Schedule</h1>

      {state.status.calendarErrors.length > 0 && (
        <Card className="mt-6 px-5 py-4">
          <p className="text-[14px] text-danger">A calendar feed is failing: {state.status.calendarErrors[0]}</p>
        </Card>
      )}

      {next && !state.live && (
        <Card className="mt-8 flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-ink-3">Up next</span>
              <StatusPill status={next.status} />
            </div>
            <div className="mt-1 truncate text-[17px] font-medium tracking-tight text-ink">{next.title}</div>
            <div className="text-[14px] text-ink-2">{isToday(next.scheduled_for) ? fmtTime(next.scheduled_for) : `Tomorrow ${fmtTime(next.scheduled_for)}`}</div>
          </div>
          <Button variant="secondary" onClick={() => void startCheckin(next.id)}>
            <Play size={14} weight="fill" /> Start early
          </Button>
        </Card>
      )}

      <section className="mt-10">
        <SectionTitle>Today</SectionTitle>
        <Timeline checkins={state.today.checkins} events={state.today.events} />
      </section>

      {(state.tomorrow.checkins.length > 0 || state.tomorrow.events.length > 0) && (
        <section className="mt-10">
          <SectionTitle>Tomorrow</SectionTitle>
          <Timeline checkins={state.tomorrow.checkins} events={state.tomorrow.events} compact />
        </section>
      )}

      <section className="mt-10">
        <SectionTitle>Said today</SectionTitle>
        {state.surfaced.length === 0 ? (
          <Empty>{mock ? 'Observations appear here once there is a brain.' : `Nothing noted yet today. ${state.assistant.name} only speaks up when it can point to something.`}</Empty>
        ) : (
          <ul className="flex flex-col gap-4">
            {state.surfaced.map((o) => (
              <li key={o.id} className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[14.5px] leading-relaxed text-ink">{o.text}</p>
                  <Evidence items={o.evidence} />
                  {o.outcome && <p className="mt-1 text-[13px] text-ink-2">Outcome: {o.outcome}</p>}
                </div>
                <button
                  type="button"
                  className="mt-1 text-ink-3 hover:text-ink"
                  title="Dismiss"
                  onClick={async () => {
                    await api.dismissObservation(o.id)
                    await refresh()
                  }}
                >
                  <X size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
