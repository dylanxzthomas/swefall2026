import { useEffect, useRef, useState } from 'react'
import { ArrowRight, ArrowLeft, Check, Plus, X, HouseSimple, CalendarBlank, Basket, Users, Microphone, Stop, ArrowDown, PencilSimple, Trash, CheckCircle, WarningCircle } from '@phosphor-icons/react'
import { attention, localDay, offsetDay, planText, type Capture, type HouseholdItem, type HouseholdProfile, type HouseholdState, type ItemInput } from '../../shared/household'
import './household.css'
import './mobile/mobile.css'
import { isNative, isLocal, localRequest, sharePlan } from './mobile/platform'

async function request<T>(path = '', method = 'GET', body?: unknown): Promise<T> {
  if (isLocal) return localRequest<T>(path, method, body)
  const response = await fetch(`/api/household${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || 'Could not save. Please try again.')
  return value as T
}
const blank = (kind: ItemInput['kind'] = 'task'): ItemInput => ({ kind, title: '', date: kind === 'shopping' ? null : localDay(), time: null, duration: 30, owner: null, person: null, notes: '' })
const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
const timeLabel = (time: string | null) => time ? new Date(`2000-01-01T${time}:00`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Any time'

function ItemFields({ item, onChange, profile }: { item: ItemInput; onChange: (item: ItemInput) => void; profile: HouseholdProfile }) {
  const set = (patch: Partial<ItemInput>) => onChange({ ...item, ...patch })
  return <div className="item-fields">
    <label className="wide">What needs to happen?<input required maxLength={200} value={item.title} onChange={e => set({ title: e.target.value })} placeholder="e.g. Pick up Maya from soccer" /></label>
    <label>Type<select value={item.kind} onChange={e => set({ kind: e.target.value as ItemInput['kind'] })}><option value="event">Event</option><option value="task">Task</option><option value="shopping">Shopping</option></select></label>
    <label>Responsible adult<select value={item.owner ?? ''} onChange={e => set({ owner: e.target.value || null })}><option value="">Not assigned</option>{profile.members.filter(m => m.role === 'adult').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
    {item.kind !== 'shopping' && <>
      <label>Date<input type="date" value={item.date ?? ''} onInput={e => set({ date: e.currentTarget.value || null, ...(!e.currentTarget.value ? { time: null } : {}) })} /></label>
      <label>Time<input type="time" value={item.time ?? ''} disabled={!item.date} onInput={e => set({ time: e.currentTarget.value || null })} /></label>
    </>}
    <details className="wide optional-fields"><summary>More details</summary><div className="item-fields">
      {item.kind === 'event' && <label>Duration (minutes)<input type="number" min={5} max={1440} required value={item.duration} onChange={e => set({ duration: Number(e.target.value) })} /></label>}
      <label>For whom?<select value={item.person ?? ''} onChange={e => set({ person: e.target.value || null })}><option value="">Whole household</option>{profile.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
    <label className="wide">Details<input value={item.notes} maxLength={2000} onChange={e => set({ notes: e.target.value })} placeholder="Location, what to bring, or quantity" /></label>
    </div></details>
  </div>
}

function Modal({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog ref={ref} aria-label={title} className="modal" onCancel={e => { e.preventDefault(); close() }} onClick={e => { if (e.target === e.currentTarget) close() }}>
    <div className="modal-head"><h2>{title}</h2><button className="icon-button" onClick={close} aria-label="Close"><X size={22} /></button></div>{children}
  </dialog>
}

export default function App() {
  const [data, setData] = useState<HouseholdState | null>(null)
  const [tab, setTab] = useState('home')
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [entryKind, setEntryKind] = useState<ItemInput['kind'] | 'update'>('task')
  const [entryDate, setEntryDate] = useState('')
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  const savingRef = useRef(new Set<string>())
  const [review, setReview] = useState<Capture | null>(null)
  const [proposals, setProposals] = useState<ItemInput[]>([])
  const [editing, setEditing] = useState<{ id?: string; item: ItemInput; done: boolean } | null>(null)
  const [profile, setProfile] = useState<HouseholdProfile | null>(null)
  const [checkin, setCheckin] = useState(false)
  const [week, setWeek] = useState(localDay())
  const [filter, setFilter] = useState('all')
  const [showDone, setShowDone] = useState(false)
  const [shopping, setShopping] = useState('')
  const [listening, setListening] = useState(false)
  const recognition = useRef<{ stop: () => void } | null>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const load = async () => setData(await request<HouseholdState>())
  useEffect(() => { void load().catch(e => setError(e.message)); return () => recognition.current?.stop() }, [])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 4500); return () => clearTimeout(t) }, [toast])
  const run = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await fn(); await load() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const openReview = (c: Capture) => { setReview(c); setProposals(structuredClone(c.items)); setError('') }
  const capture = async () => {
    if (busy || !text.trim()) return
    setBusy(true); setError('')
    try {
      if (entryKind === 'update') {
        const c = await request<Capture>('/capture', 'POST', { text })
        setData(d => d && ({ ...d, captures: [...d.captures, c] }))
        openReview(c)
      } else {
        const item = await request<HouseholdItem>('/items', 'POST', { ...blank(entryKind), title: text.trim(), date: entryKind === 'shopping' ? null : entryDate || null })
        setData(d => d && ({ ...d, items: [...d.items, item] }))
        setToast('Added.'); if (entryKind === 'shopping') setTab('shopping')
      }
      setText(''); composer.current?.focus()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const toggle = async (i: HouseholdItem) => {
    if (savingRef.current.has(i.id)) return
    savingRef.current.add(i.id); setSavingIds(new Set(savingRef.current)); setError('')
    setData(d => d && ({ ...d, items: d.items.map(x => x.id === i.id ? { ...x, done: !i.done } : x) }))
    try { await request(`/items/${i.id}`, 'PUT', { ...i, done: !i.done }) }
    catch (e) {
      setData(d => d && ({ ...d, items: d.items.map(x => x.id === i.id ? { ...x, done: i.done } : x) }))
      setError((e as Error).message)
    } finally { savingRef.current.delete(i.id); setSavingIds(new Set(savingRef.current)) }
  }
  const edit = (i: HouseholdItem) => { setEditing({ id: i.id, item: { ...i }, done: i.done }); setError('') }
  const speak = () => {
    if (listening) { recognition.current?.stop(); return }
    type SpeechEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> }
    type Recognition = { lang: string; interimResults: boolean; onresult: ((e: SpeechEvent) => void) | null; onerror: (() => void) | null; onend: (() => void) | null; start: () => void; stop: () => void }
    const browser = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
    const Constructor = browser.SpeechRecognition ?? browser.webkitSpeechRecognition
    if (!Constructor) { setError('Voice input is not supported in this browser. You can type or paste your update.'); return }
    const r = new Constructor(); r.lang = navigator.language; r.interimResults = false
    r.onresult = e => { const transcript = Array.from(e.results).map(result => result[0].transcript).join(' '); setText(t => `${t}${t ? '\n' : ''}${transcript}`) }
    r.onerror = () => { setListening(false); setError('Could not hear you. Check microphone permission, or type your update.') }
    r.onend = () => setListening(false)
    recognition.current = r
    try { r.start(); setListening(true) } catch { setError('Could not start the microphone. Please type your update.') }
  }
  const download = async () => {
    if (!data) return
    if (isNative) {
      try { await sharePlan(planText(data)) } catch { /* Dismissing the share sheet leaves the plan unchanged. */ }
      return
    }
    const url = URL.createObjectURL(new Blob([planText(data)], { type: 'text/plain' }))
    const a = document.createElement('a'); a.href = url; a.download = `family-plan-${localDay()}.txt`; a.click(); URL.revokeObjectURL(url)
    setToast('Family plan downloaded.')
  }
  if (!data) return <div className="loading"><HouseSimple size={36} /><h1>Homeline</h1><p>{error || 'Opening your home…'}</p>{error && <button onClick={() => void run(load)}>Try again</button>}</div>
  const today = localDay(), alerts = attention(data), pending = data.captures.filter(c => c.status === 'pending')
  const member = (id: string | null) => data.profile.members.find(m => m.id === id)?.name
  const next = data.items.filter(i => !i.done && i.kind !== 'shopping' && i.date && i.date >= today && i.date < offsetDay(today, 7)).sort((a, b) => `${a.date}${a.time ?? '99'}`.localeCompare(`${b.date}${b.time ?? '99'}`))
  const groceries = data.items.filter(i => i.kind === 'shopping')
  const row = (item: HouseholdItem) => <div className={`plan-row ${item.done ? 'completed' : ''}`} key={item.id}>
    <button className="check-button" disabled={savingIds.has(item.id)} aria-label={`${item.done ? 'Reopen' : 'Complete'} ${item.title}`} onClick={() => void toggle(item)}>{item.done && <Check size={14} weight="bold" />}</button>
    <button className="row-content" onClick={() => edit(item)}><strong>{item.title}</strong><span>{item.kind !== 'shopping' ? `${timeLabel(item.time)}${item.kind === 'event' && item.time ? ` · ${item.duration} min` : ''} · ` : ''}{member(item.person) ? `${member(item.person)} · ` : ''}{item.notes || (item.kind === 'shopping' ? 'Shopping' : item.kind === 'event' ? 'Family event' : 'To do')}</span></button>
    <button className={`owner ${item.owner ? '' : 'unassigned'}`} onClick={() => edit(item)}>{member(item.owner) ?? 'Assign'}</button>
  </div>
  const inlineError = error && <div className="error" role="alert">{error}</div>
  const activeModal = review || editing || profile || checkin
  return <div className="home-app">
    <header className="topbar"><a href="#" aria-label="Homeline home" className="brand" onClick={() => setTab('home')}><HouseSimple size={28} weight="bold" />homeline</a>
      <nav aria-label="Main navigation">{[{ id: 'home', label: 'Home', icon: HouseSimple }, { id: 'week', label: 'Plan', icon: CalendarBlank }, { id: 'shopping', label: 'Shopping', icon: Basket }].map(n => <button key={n.id} className={tab === n.id ? 'active' : ''} aria-current={tab === n.id ? 'page' : undefined} onClick={() => { setTab(n.id); window.scrollTo(0, 0) }}><n.icon size={18} /><span>{n.label}</span></button>)}</nav>
      <button aria-label="Your household" className="household-button" onClick={() => { setProfile(structuredClone(data.profile)); setError('') }}><Users size={19} /><span>{data.profile.name}</span></button>
    </header>
    <main className="page">
      {!activeModal && inlineError}
      {tab === 'home' && <>
        <section className="hero">
          <h1>What needs doing?</h1>
          <form className="capture-box" onSubmit={e => { e.preventDefault(); void capture() }}>
            <div className="entry-types" role="group" aria-label="Add type">{(['task', 'event', 'shopping', 'update'] as const).map(kind => <button type="button" key={kind} aria-pressed={entryKind === kind} onClick={() => setEntryKind(kind)}>{kind === 'update' ? 'Paste an update' : kind === 'shopping' ? 'Shopping' : kind === 'event' ? 'Event' : 'Task'}</button>)}</div>
            <label htmlFor="update" className="sr-only">Your household update</label>
            <textarea enterKeyHint={entryKind === 'update' ? 'enter' : 'done'} id="update" ref={composer} maxLength={entryKind === 'update' ? 12000 : 200} rows={2} required value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && entryKind !== 'update') { e.preventDefault(); void capture() } }} placeholder={entryKind === 'update' ? 'Paste a school message…' : entryKind === 'shopping' ? 'Milk, snacks, school supplies…' : entryKind === 'event' ? 'Soccer practice…' : 'Return the permission slip…'} />
            <div className="capture-footer"><div className="actions">{!isNative && <button type="button" className={`icon-button ${listening ? 'recording' : ''}`} aria-label={listening ? 'Stop listening' : 'Speak'} onClick={speak}>{listening ? <Stop size={20} weight="fill" /> : <Microphone size={20} />}</button>}{entryKind !== 'shopping' && entryKind !== 'update' && <input className="entry-date" aria-label="Date (optional)" type="date" value={entryDate} onInput={e => setEntryDate(e.currentTarget.value)} />}</div><button className="primary" disabled={busy || !text.trim()}>{busy ? (entryKind === 'update' ? 'Reading…' : 'Saving…') : entryKind === 'update' ? 'Review' : 'Add'}{entryKind === 'update' ? <ArrowRight size={17} /> : <Plus size={17} />}</button></div>
            {entryKind === 'update' && data.mode === 'guided' && <p className="mode-note">Manual mode: one item per line. Confirm dates in review.</p>}
          </form>
        </section>
        {!!pending.length && <div className="pending-list">{pending.map(c => <button className="pending-row" key={c.id} onClick={() => openReview(c)}><span>Review update · {c.items.length} items</span><ArrowRight size={17} /></button>)}</div>}
        <section className="agenda-section"><div className="section-heading"><h2>Next up</h2><div className="actions">{!!alerts.length && <button className="text-button" onClick={() => setCheckin(true)}>{alerts.length} to review</button>}<button className="text-button" onClick={() => setTab('week')}>View week <ArrowRight size={16} /></button></div></div>
          {next.slice(0, 5).map(i => <div className="upcoming" key={i.id}><div className="date-column"><strong>{new Date(`${i.date}T12:00:00`).getDate()}</strong><span>{new Date(`${i.date}T12:00:00`).toLocaleDateString([], { weekday: 'short' })}</span></div>{row(i)}</div>)}
          {data.items.filter(i => !i.done && i.kind !== 'shopping' && (!i.date || i.date < today)).slice(0, 5).map(row)}
          {!data.items.some(i => !i.done && i.kind !== 'shopping') && <p className="quiet-empty">Nothing pending. Add something above.</p>}
        </section>
      </>}
      {tab === 'week' && <>
        <div className="page-heading"><div><h1>Family plan</h1></div><div className="actions"><button className="secondary" onClick={download}><ArrowDown size={17} />{isNative ? 'Share' : 'Export'}</button><button className="primary" onClick={() => setEditing({ item: blank('event'), done: false })}><Plus size={17} />Add a plan</button></div></div>
        <div className="plan-toolbar"><div className="actions"><button className="icon-button" aria-label="Previous week" onClick={() => setWeek(offsetDay(week, -7))}><ArrowLeft size={18} /></button><strong>{dayLabel(week)} – {dayLabel(offsetDay(week, 6))}</strong><button className="icon-button" aria-label="Next week" onClick={() => setWeek(offsetDay(week, 7))}><ArrowRight size={18} /></button><button className="text-button" onClick={() => setWeek(today)}>Today</button></div><div className="actions"><select aria-label="Filter by family member" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">Everyone</option>{data.profile.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select><label className="checkbox-label"><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} />Show done</label></div></div>
        {Array.from({ length: 7 }, (_, n) => offsetDay(week, n)).map(day => {
          const items = data.items.filter(i => i.kind !== 'shopping' && i.date === day && (showDone || !i.done) && (filter === 'all' || i.owner === filter || i.person === filter)).sort((a, b) => (a.time ?? '99').localeCompare(b.time ?? '99'))
          return <section className="day-section" key={day}><h3>{dayLabel(day)}{day === today && <span className="tag">TODAY</span>}</h3><div>{items.length ? items.map(row) : <p className="day-empty">Nothing planned.</p>}</div></section>
        })}
        {!!data.items.filter(i => !i.done && i.kind !== 'shopping' && (!i.date || i.date < today)).length && <section className="backlog"><h2>Still needs a plan</h2><p>Undated and past-due items stay here until you finish or reschedule them.</p>{data.items.filter(i => !i.done && i.kind !== 'shopping' && (!i.date || i.date < today)).map(row)}</section>}
      </>}
      {tab === 'shopping' && <>
        <div className="page-heading"><div><h1>Shopping list</h1></div><button className="secondary" onClick={download}><ArrowDown size={17} />{isNative ? 'Share' : 'Export'}</button></div>
        <form className="quick-add" onSubmit={e => { e.preventDefault(); void run(async () => { await request('/items', 'POST', { ...blank('shopping'), title: shopping }); setShopping('') }) }}><input aria-label="Shopping item" required maxLength={200} placeholder="Add milk, school supplies, anything…" value={shopping} onChange={e => setShopping(e.target.value)} /><button className="primary" disabled={busy || !shopping.trim()}><Plus size={19} />Add</button></form>
        <section className="shopping-list">{groceries.filter(i => !i.done).length ? groceries.filter(i => !i.done).map(row) : <div className="empty"><Basket size={30} /><h3>{groceries.length ? 'Everything checked off.' : 'Nothing on the list yet.'}</h3></div>}{!!groceries.filter(i => i.done).length && <details><summary>Picked up ({groceries.filter(i => i.done).length})</summary>{groceries.filter(i => i.done).map(row)}</details>}</section>
      </>}

    </main>
    {toast && <div className="toast" role="status"><CheckCircle size={18} />{toast}</div>}
    {review && <Modal title="Review your update" close={() => { if (!busy) setReview(null) }}>
      {inlineError}
      <details className="source"><summary>Original update</summary><p>{review.text}</p></details>
      {review.mode === 'ai' && !!review.questions.length && <div className="review-notes">{review.questions.map((q, n) => <p key={n}><WarningCircle size={17} />{q}</p>)}</div>}
      <form onSubmit={e => { e.preventDefault(); void run(async () => { await request(`/captures/${review.id}/approve`, 'POST', { items: proposals }); setReview(null); setToast('Added to your family plan.'); }) }}>
        {proposals.map((item, n) => <section className="compact-proposal" key={n}>
          <div className="proposal-line"><input aria-label={`Item ${n + 1}`} required maxLength={200} value={item.title} onChange={e => setProposals(p => p.map((x, i) => i === n ? { ...x, title: e.target.value } : x))} /><button type="button" className="icon-button" aria-label={`Remove item ${n + 1}`} onClick={() => setProposals(p => p.filter((_, i) => n !== i))}><X size={17} /></button></div>
          <details><summary>{item.kind}{item.date ? ` · ${dayLabel(item.date)}` : item.kind !== 'shopping' ? ' · No date' : ''}{item.owner ? ` · ${member(item.owner)}` : ''} · Edit details</summary><ItemFields item={item} profile={data.profile} onChange={v => setProposals(p => p.map((x, i) => i === n ? v : x))} /></details>
        </section>)}
        <button className="text-button" type="button" onClick={() => setProposals(p => [...p, blank()])}><Plus size={16} />Add another item</button>
        <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => { await request(`/captures/${review.id}/dismiss`, 'POST'); setReview(null) })}>Discard update</button><button className="primary" disabled={busy || !proposals.length}>{busy ? 'Saving…' : `Approve ${proposals.length} ${proposals.length === 1 ? 'item' : 'items'}`}<Check size={17} /></button></div>
      </form>
    </Modal>}
    {editing && <Modal title={editing.id ? 'Edit your plan' : 'Add to your household'} close={() => { if (!busy) setEditing(null) }}>{inlineError}
      <form onSubmit={e => { e.preventDefault(); void run(async () => { await request(editing.id ? `/items/${editing.id}` : '/items', editing.id ? 'PUT' : 'POST', { ...editing.item, done: editing.done }); setEditing(null); setToast('Saved to your household.'); }) }}><ItemFields item={editing.item} profile={data.profile} onChange={item => setEditing({ ...editing, item })} />
        {editing.id && data.items.find(i => i.id === editing.id)?.sourceId && <details className="source"><summary>Where this came from</summary><p>{data.captures.find(c => c.id === data.items.find(i => i.id === editing.id)?.sourceId)?.text}</p></details>}
        <div className="modal-actions">{editing.id ? <button type="button" className="text-button danger" disabled={busy} onClick={() => void run(async () => { await request(`/items/${editing.id}`, 'DELETE'); setEditing(null); setToast('Item removed.'); })}><Trash size={17} />Delete</button> : <span />}<button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}<Check size={17} /></button></div>
      </form>
    </Modal>}
    {profile && <Modal title="Your household" close={() => { if (!busy) setProfile(null) }}><p className="modal-intro">{isLocal ? 'Saved on this device. No account or sync yet.' : 'Add the people you plan for.'}</p>{inlineError}
      <form onSubmit={e => { e.preventDefault(); void run(async () => { await request('/profile', 'PUT', profile); setProfile(null); setToast('Household saved.'); }) }}><label>Household name<input required maxLength={80} value={profile.name} onChange={e => setProfile({ ...profile, name: e.target.value })} /></label>
        <div className="members">{profile.members.map((m, index) => <div className="member-row" key={m.id}><input aria-label={`Name for family member ${index + 1}`} required maxLength={60} value={m.name} placeholder="Name" onChange={e => setProfile({ ...profile, members: profile.members.map(x => x.id === m.id ? { ...x, name: e.target.value } : x) })} /><select aria-label={`Role for ${m.name}`} value={m.role} onChange={e => setProfile({ ...profile, members: profile.members.map(x => x.id === m.id ? { ...x, role: e.target.value as 'adult' | 'child' } : x) })}><option value="adult">Adult</option><option value="child">Child</option></select><button type="button" className="icon-button" aria-label={`Remove ${m.name}`} onClick={() => setProfile({ ...profile, members: profile.members.filter(x => x.id !== m.id) })}><X size={17} /></button></div>)}</div>
        <button type="button" className="text-button" onClick={() => setProfile({ ...profile, members: [...profile.members, { id: crypto.randomUUID(), name: '', role: 'child' }] })}><Plus size={16} />Add family member</button>
        <label className="notes-label">Useful things to remember<textarea rows={3} maxLength={4000} value={profile.notes} onChange={e => setProfile({ ...profile, notes: e.target.value })} placeholder="School names, usual pickup arrangements, household preferences…" /></label><p className="small-note">Removing an adult leaves their tasks unassigned. Assignments here do not notify anyone.</p><div className="modal-actions"><span /><button className="primary" disabled={busy}>Save household<Check size={17} /></button></div>
      </form>
    </Modal>}
    {checkin && <Modal title="A quick look at your week" close={() => setCheckin(false)}><p className="modal-intro">{next.length} upcoming {next.length === 1 ? 'plan' : 'plans'}. {groceries.filter(i => !i.done).length} {groceries.filter(i => !i.done).length === 1 ? 'thing' : 'things'} to pick up. Start with anything that needs a decision.</p>{inlineError}
      {alerts.length ? alerts.map(a => <div className="brief-decision" key={a.id}><span className="tag warning">{a.kind === 'conflict' ? 'OVERLAP' : 'FOLLOW UP'}</span><h3>{a.title}</h3><p>{a.detail}</p><div className="actions">{a.itemIds.map(id => <button className="secondary" key={id} onClick={() => { setCheckin(false); edit(data.items.find(i => i.id === id)!) }}><PencilSimple size={15} />{data.items.find(i => i.id === id)?.title}</button>)}</div></div>) : <div className="empty"><CheckCircle size={32} /><h3>{next.length ? 'Your plans have coverage.' : 'What’s happening this week?'}</h3><p>{next.length ? 'No overlapping timed events or unassigned plans found in the next seven days. Travel time is not included.' : 'Add the first event or task, and we’ll help you spot what needs attention.'}</p></div>}
      <div className="brief-decision"><h3>What changed since last time?</h3><p>A new school message, a different pickup, or something you need to buy?</p><button className="text-button" onClick={() => { setCheckin(false); setTab('home'); setTimeout(() => composer.current?.focus(), 50) }}>Add an update <ArrowRight size={16} /></button></div><div className="modal-actions"><button className="secondary" onClick={download}><ArrowDown size={17} />{isNative ? 'Share plan' : 'Download the plan'}</button><button className="primary" onClick={() => { setCheckin(false); setToast('Your plan is ready to use.'); }}>Done for now <Check size={17} /></button></div>
    </Modal>}
  </div>
}
