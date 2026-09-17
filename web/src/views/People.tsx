import { useEffect, useRef, useState } from 'react'
import { Check, MagnifyingGlass, Plus, Trash } from '@phosphor-icons/react'
import type { Person, PersonDetail } from '../../../shared/types'
import { api, fmtDate, fmtDay, fmtTime } from '../api'
import { useStore } from '../store'
import { Button, Empty, Evidence, SectionTitle, inputCls, textareaCls } from '../components/ui'

function EditableText({ value, placeholder, onSave, rows = 2 }: { value: string | null; placeholder: string; onSave: (v: string) => Promise<void>; rows?: number }) {
  const [v, setV] = useState(value ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => setV(value ?? ''), [value])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (!v) {
      el.style.height = ''
      return
    }
    el.style.height = '0px'
    el.style.height = `${Math.max(rows * 24, el.scrollHeight)}px`
  }, [v, rows])
  return (
    <textarea
      ref={ref}
      rows={rows}
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if ((value ?? '') !== v) void onSave(v)
      }}
      className={`${textareaCls} resize-none border-transparent bg-transparent px-0 hover:border-line focus:bg-paper-2 focus:px-3`}
    />
  )
}

export function People({ id }: { id?: string }) {
  const { navigate, state } = useStore()
  const [list, setList] = useState<Person[]>([])
  const [q, setQ] = useState('')
  const [detail, setDetail] = useState<PersonDetail | null>(null)
  const [newName, setNewName] = useState('')
  const [fact, setFact] = useState('')

  const load = () => api.people(q || undefined).then(setList)
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, state?.now])
  useEffect(() => {
    if (!id) return setDetail(null)
    api.person(id).then(setDetail).catch(() => setDetail(null))
  }, [id, state?.now])

  const save = async (patch: Partial<Person>) => {
    if (!detail) return
    const p = await api.updatePerson(detail.person.id, patch)
    setDetail({ ...detail, person: p })
    void load()
  }
  const reload = async () => {
    if (id) setDetail(await api.person(id))
    void load()
  }

  return (
    <div className="grid h-full grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)]">
      <div className="flex flex-col border-b border-line lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-2 px-4 py-3">
          <div className="relative flex-1">
            <MagnifyingGlass size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" className={`${inputCls} pl-9`} />
          </div>
        </div>
        <ul className="max-h-[40vh] overflow-y-auto lg:max-h-none lg:flex-1">
          {list.length === 0 && <li className="px-4 py-6 text-[13.5px] text-ink-3">No one on file yet. People arrive from your calendar and from what you say in conversations.</li>}
          {list.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => navigate(`#/people/${p.id}`)} className={`block w-full px-4 py-2.5 text-left hover:bg-paper-2 ${id === p.id ? 'bg-paper-2' : ''}`}>
                <div className="truncate text-[14.5px] font-medium text-ink">{p.name}</div>
                <div className="truncate text-[12.5px] text-ink-3">{[p.role, p.company].filter(Boolean).join(', ') || p.relationship || (p.last_contact_at ? `Last contact ${fmtDate(p.last_contact_at)}` : 'Nothing on file')}</div>
              </button>
            </li>
          ))}
        </ul>
        <form
          className="flex items-center gap-2 border-t border-line px-4 py-3"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!newName.trim()) return
            const p = await api.createPerson(newName.trim())
            setNewName('')
            await load()
            navigate(`#/people/${p.id}`)
          }}
        >
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Add someone" className={inputCls} />
          <Button size="sm" type="submit" disabled={!newName.trim()} aria-label="Add">
            <Plus size={14} />
          </Button>
        </form>
      </div>

      <div className="overflow-y-auto px-6 py-8 lg:px-10">
        {!detail ? (
          <p className="text-[14px] text-ink-3">Pick someone.</p>
        ) : (
          <div className="mx-auto max-w-[720px]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-[26px] font-medium leading-tight tracking-tight text-ink">{detail.person.name}</h1>
                <div className="mt-1 text-[14px] text-ink-2">
                  {[detail.person.role, detail.person.company].filter(Boolean).join(', ') || 'Role and company unknown'}
                  {detail.person.last_contact_at && <span className="text-ink-3"> · last contact {fmtDay(detail.person.last_contact_at)}</span>}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  if (!confirm(`Forget ${detail.person.name} entirely?`)) return
                  await api.deletePerson(detail.person.id)
                  navigate('#/people')
                  void load()
                }}
              >
                <Trash size={14} /> Forget
              </Button>
            </div>

            <div className="mt-8 grid gap-6 sm:grid-cols-2">
              <div>
                <div className="text-[13px] font-medium text-ink-2">Who they are to you</div>
                <EditableText value={detail.person.relationship} placeholder="Co-founder, investor, old friend" onSave={(v) => save({ relationship: v })} rows={1} />
              </div>
              <div>
                <div className="text-[13px] font-medium text-ink-2">Role, company</div>
                <EditableText value={[detail.person.role, detail.person.company].filter(Boolean).join(', ')} placeholder="VP Product, Acme" onSave={(v) => { const [role, ...rest] = v.split(','); return save({ role: role.trim() || null, company: rest.join(',').trim() || null }) }} rows={1} />
              </div>
            </div>
            <div className="mt-6 flex flex-col gap-6">
              <div>
                <div className="text-[13px] font-medium text-ink-2">Summary</div>
                <EditableText value={detail.person.summary} placeholder="One or two lines that would brief a stranger." onSave={(v) => save({ summary: v })} />
              </div>
              <div className="grid gap-6 sm:grid-cols-2">
                <div>
                  <div className="text-[13px] font-medium text-ink-2">What they want</div>
                  <EditableText value={detail.person.wants} placeholder="What they are after, said or not." onSave={(v) => save({ wants: v })} />
                </div>
                <div>
                  <div className="text-[13px] font-medium text-ink-2">What to avoid</div>
                  <EditableText value={detail.person.avoid} placeholder="Slides. Small talk. Surprises." onSave={(v) => save({ avoid: v })} />
                </div>
              </div>
            </div>

            <section className="mt-10">
              <SectionTitle>Facts</SectionTitle>
              {detail.facts.length === 0 ? <Empty>Nothing specific yet.</Empty> : (
                <ul className="flex flex-col gap-3">
                  {detail.facts.map((f) => (
                    <li key={f.id} className="group flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-[14.5px] text-ink">{f.text}</p>
                        <p className="text-[12.5px] text-ink-3">
                          {fmtDate(f.created_at)} · {f.source}
                        </p>
                        {f.evidence && <Evidence items={[f.evidence]} />}
                      </div>
                      <button type="button" className="text-ink-3 opacity-0 hover:text-danger group-hover:opacity-100" title="Retire this fact" onClick={async () => { await api.deleteFact(f.id); await reload() }}>
                        <Trash size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <form
                className="mt-4 flex gap-2"
                onSubmit={async (e) => {
                  e.preventDefault()
                  if (!fact.trim()) return
                  await api.addFact(detail.person.id, fact.trim())
                  setFact('')
                  await reload()
                }}
              >
                <input value={fact} onChange={(e) => setFact(e.target.value)} placeholder="Add something you know" className={inputCls} />
                <Button type="submit" size="md" disabled={!fact.trim()}>
                  Add
                </Button>
              </form>
            </section>

            <section className="mt-10">
              <SectionTitle>Open between you</SectionTitle>
              {detail.commitments.filter((c) => c.status === 'open').length === 0 ? <Empty>Nothing open.</Empty> : (
                <ul className="flex flex-col gap-2">
                  {detail.commitments.filter((c) => c.status === 'open').map((c) => (
                    <li key={c.id} className="flex items-center gap-3 text-[14.5px] text-ink">
                      <button type="button" className="flex h-5 w-5 items-center justify-center rounded-full border border-line-2 text-transparent hover:border-accent hover:text-accent" title="Mark done" onClick={async () => { await api.closeCommitment(c.id, 'done'); await reload() }}>
                        <Check size={12} weight="bold" />
                      </button>
                      <span className="flex-1">
                        {c.owner === 'me' ? 'You owe: ' : 'They owe: '}
                        {c.text}
                      </span>
                      {c.due && <span className={`font-mono text-[12px] ${new Date(c.due) < new Date() ? 'text-danger' : 'text-ink-3'}`}>{fmtDate(c.due)}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {detail.events.length > 0 && (
              <section className="mt-10">
                <SectionTitle>Meetings</SectionTitle>
                <ul className="flex flex-col gap-1.5">
                  {detail.events.map((e) => (
                    <li key={e.id} className="flex gap-3 text-[14px]">
                      <span className="w-28 shrink-0 font-mono text-[12.5px] text-ink-3">
                        {fmtDay(e.start)} {fmtTime(e.start)}
                      </span>
                      <span className={new Date(e.start) < new Date() ? 'text-ink-2' : 'text-ink'}>{e.title}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {detail.observations.length > 0 && (
              <section className="mt-10">
                <SectionTitle>What {state?.assistant.name} has noticed</SectionTitle>
                <ul className="flex flex-col gap-4">
                  {detail.observations.map((o) => (
                    <li key={o.id}>
                      <p className="text-[14.5px] text-ink">{o.text}</p>
                      <p className="text-[12.5px] text-ink-3">
                        {o.kind} · {o.status} · {fmtDate(o.created_at)}
                        {o.outcome ? ` · outcome: ${o.outcome}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
