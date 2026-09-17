import { useEffect, useState } from 'react'
import { Check } from '@phosphor-icons/react'
import type { MemoryDTO } from '../../../shared/types'
import { api, fmtDate } from '../api'
import { useStore } from '../store'
import { Button, Empty, Evidence, SectionTitle, textareaCls } from '../components/ui'

export function Memory() {
  const { state, navigate, thinkNow } = useStore()
  const [m, setM] = useState<MemoryDTO | null>(null)
  const [profile, setProfile] = useState('')
  const [saved, setSaved] = useState(false)
  const [showClosed, setShowClosed] = useState(false)

  const load = () =>
    api.memory().then((d) => {
      setM(d)
      setProfile((p) => (p && p !== d.profile && !saved ? p : d.profile))
    })
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.now])

  if (!m || !state) return <div className="p-10 text-ink-3">Loading.</div>
  const personName = (id: string | null) => (id ? m.people.find((p) => p.id === id)?.name ?? null : null)
  const commitments = m.commitments.filter((c) => showClosed || c.status === 'open')

  return (
    <div className="mx-auto max-w-[880px] px-6 py-8 lg:px-10 lg:py-12">
      <h1 className="text-[28px] font-medium leading-tight tracking-tight text-ink">What {state.assistant.name} knows</h1>
      <p className="mt-2 text-[15px] text-ink-2">
        Today: ${m.usageToday.costUsd.toFixed(2)} of ${m.usageToday.budgetUsd.toFixed(0)} spent across {m.usageToday.calls} call{m.usageToday.calls === 1 ? '' : 's'}.
        {state.providers.brain === 'claude' && (
          <>
            {' '}
            <button type="button" className="text-ink-3 underline decoration-line underline-offset-4 hover:text-accent" onClick={() => void thinkNow()} title="Run a dead-time thinking pass right now">
              Think now
            </button>
          </>
        )}
      </p>

      <section className="mt-10">
        <SectionTitle
          right={
            <Button
              size="sm"
              onClick={async () => {
                await api.saveProfile(profile)
                setSaved(true)
                setTimeout(() => setSaved(false), 1500)
                await load()
              }}
            >
              {saved ? <Check size={14} /> : null} {saved ? 'Saved' : 'Save'}
            </Button>
          }
        >
          About you
        </SectionTitle>
        <textarea value={profile} onChange={(e) => setProfile(e.target.value)} rows={16} className={`${textareaCls} font-mono text-[13px]`} spellCheck={false} />
        <p className="mt-2 text-[12.5px] text-ink-3">Read before every conversation. {state.assistant.name} appends lines here as it learns things; you can rewrite any of it.</p>
      </section>

      <section className="mt-12">
        <SectionTitle
          right={
            <button type="button" className="text-[13px] text-ink-3 hover:text-ink" onClick={() => setShowClosed((v) => !v)}>
              {showClosed ? 'Hide closed' : 'Show closed'}
            </button>
          }
        >
          Promises
        </SectionTitle>
        {commitments.length === 0 ? <Empty>Nothing open.</Empty> : (
          <ul className="flex flex-col gap-2">
            {commitments.map((c) => {
              const who = personName(c.person_id)
              return (
                <li key={c.id} className={`flex items-center gap-3 text-[14.5px] ${c.status === 'open' ? 'text-ink' : 'text-ink-3 line-through'}`}>
                  <button
                    type="button"
                    title={c.status === 'open' ? 'Mark done' : 'Reopen'}
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${c.status === 'open' ? 'border-line-2 text-transparent hover:border-accent hover:text-accent' : 'border-accent bg-accent text-accent-ink'}`}
                    onClick={async () => {
                      if (c.status === 'open') await api.closeCommitment(c.id, 'done')
                      else await api.reopenCommitment(c.id)
                      await load()
                    }}
                  >
                    <Check size={12} weight="bold" />
                  </button>
                  <span className="min-w-0 flex-1">
                    {c.owner === 'me' ? `You owe${who ? ` ${who}` : ''}: ` : `${who ?? 'Someone'} owes you: `}
                    {c.text}
                  </span>
                  {c.due && <span className={`font-mono text-[12px] ${c.status === 'open' && new Date(c.due) < new Date() ? 'text-danger' : 'text-ink-3'}`}>{fmtDate(c.due)}</span>}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="mt-12">
        <SectionTitle>Observations</SectionTitle>
        {m.observations.length === 0 ? <Empty>{state.providers.brain === 'mock' ? 'Observations need a brain.' : `None yet. ${state.assistant.name} writes one only when it can point to evidence.`}</Empty> : (
          <ul className="flex flex-col gap-5">
            {m.observations.map((o) => (
              <li key={o.id}>
                <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
                  <span className="font-medium text-ink-2">{o.kind}</span>
                  <span>{o.status}</span>
                  <span>{fmtDate(o.created_at)}</span>
                  {o.surface_when === 'never' && <span>note to self</span>}
                  {personName(o.person_id) && (
                    <button type="button" className="hover:text-accent" onClick={() => navigate(`#/people/${o.person_id}`)}>
                      {personName(o.person_id)}
                    </button>
                  )}
                </div>
                <p className="mt-0.5 text-[14.5px] leading-relaxed text-ink">{o.text}</p>
                <Evidence items={o.evidence} />
                {o.outcome && <p className="mt-1 text-[13px] text-ink-2">Outcome: {o.outcome}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-12">
        <SectionTitle>Recent facts</SectionTitle>
        {m.facts.length === 0 ? <Empty>No facts recorded yet.</Empty> : (
          <ul className="flex flex-col gap-3">
            {m.facts.slice(0, 25).map((f) => (
              <li key={f.id} className="text-[14.5px] text-ink">
                {personName(f.person_id) && (
                  <button type="button" className="mr-1.5 font-medium text-ink-2 hover:text-accent" onClick={() => navigate(`#/people/${f.person_id}`)}>
                    {personName(f.person_id)}:
                  </button>
                )}
                {f.text}
                <span className="ml-1.5 text-[12.5px] text-ink-3">{fmtDate(f.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {m.notes.length > 0 && (
        <section className="mt-12">
          <SectionTitle>Notes {state.assistant.name} keeps</SectionTitle>
          <ul className="flex flex-col gap-2">
            {m.notes.map((n) => (
              <li key={n.id} className="text-[14px] text-ink-2">
                <span className="mr-2 font-mono text-[12px] text-ink-3">{fmtDate(n.created_at)}</span>
                {n.text}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
