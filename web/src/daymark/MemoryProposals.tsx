import { useRef, useState } from 'react'
import type { FamilyFact } from '../../../shared/memory'
import { parseMemoryCandidate, type MemoryProposal } from '../../../shared/memoryProposals'
import type { DaymarkClient, DaymarkState } from './types'
import FamilyFactFields, { describeFamilyFact, emptyFamilyFact } from './FamilyFactFields'

export function MemoryProposalReview({ proposal, state, client, onClose }: { proposal: MemoryProposal; state: DaymarkState; client: DaymarkClient; onClose(): void }) {
  const [value, setValue] = useState<FamilyFact | null>(proposal.value ?? null), [replacement, setReplacement] = useState<{ id: string; version: number } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const pending = useRef(false)
  const replaceFact = (state.facts ?? []).find(fact => fact._id === replacement?.id)
  const replacementChanged = Boolean(replacement && (!replaceFact || replaceFact.version !== replacement.version))
  const run = async (operation: () => Promise<unknown>) => {
    if (pending.current) return
    pending.current = true
    setBusy(true); setError('')
    try { await operation(); onClose() } catch (cause) { setError((cause as Error).message) } finally { pending.current = false; setBusy(false) }
  }
  return <section className="dm-fields" aria-label="Review memory suggestion">
    <p>{proposal.text}</p>
    <p className="dm-muted">Not remembered yet. Confirm the exact detail below. {state.storage === 'device' ? 'It will stay in this device’s household memory.' : 'Confirmed details are shared with the adults in your household.'}</p>
    <label>What to remember<select value={value?.kind ?? ''} disabled={busy} onChange={event => { setValue(event.target.value ? emptyFamilyFact(event.target.value as FamilyFact['kind'], state) : null); setReplacement(null) }}>
      <option value="">Choose a kind of detail</option><option value="school">School or class</option><option value="contact">School contact</option><option value="routine">Weekly pickup preference</option><option value="availability">Availability on one date</option>
    </select></label>
    {!value && <p className="dm-muted">These are the household details Sola can remember today. General preferences are not supported yet.</p>}
    {value && <>
      <FamilyFactFields value={value} onChange={next => { if (!pending.current) setValue(next) }} state={state} disabled={busy} />
      {(state.facts ?? []).some(fact => fact.key.startsWith('family:') && fact.value.kind === value.kind) && <label>Save as<select value={replacement?.id ?? ''} disabled={busy} onChange={event => { const selected = state.facts?.find(fact => fact._id === event.target.value); setReplacement(selected ? { id: selected._id, version: selected.version } : null) }}><option value="">A new detail</option>{(state.facts ?? []).filter(fact => fact.key.startsWith('family:') && fact.value.kind === value.kind).map(fact => <option key={fact._id} value={fact._id}>Replace: {describeFamilyFact(fact.value, state)}</option>)}</select></label>}
      {replacementChanged && <div><p role="alert">The saved detail changed while you were reviewing it. Review its latest version before replacing it.</p>{replaceFact ? <button disabled={busy} onClick={() => { setValue(replaceFact.value); setReplacement({ id: replaceFact._id, version: replaceFact.version }) }}>Review latest saved detail</button> : <button disabled={busy} onClick={() => setReplacement(null)}>Save as a new detail instead</button>}</div>}
      <button disabled={busy || replacementChanged || !client.confirmMemory} onClick={() => void run(async () => { const checked = parseMemoryCandidate(value); if (replacementChanged) throw new Error('That saved detail changed. Review it again.'); return client.confirmMemory!(proposal._id, proposal.version, checked, replacement?.id, replacement?.version) })}>Confirm and remember</button>
    </>}
    <div className="dm-actions"><button disabled={busy || !client.dismissMemory} onClick={() => void run(() => client.dismissMemory!(proposal._id, proposal.version))}>Dismiss suggestion</button><button disabled={busy} onClick={onClose}>Review later</button></div>
    <p className="dm-muted">Unconfirmed suggestions are kept for up to 30 days. Remembering a detail never approves a message or calendar change.</p>
    {error && <p role="alert">{error}</p>}
  </section>
}

export function MemoryProposalList({ state, client }: { state: DaymarkState; client: DaymarkClient }) {
  const [selected, setSelected] = useState<string | null>(null)
  const proposals = state.memoryProposals ?? []
  if (!proposals.length) return null
  return <section aria-label="Memory suggestions"><h3>Waiting for your confirmation</h3><p className="dm-muted">{state.storage === 'device' ? 'These suggestions stay in this device workspace.' : 'Only you can see these suggestions until you confirm them.'}</p>{proposals.map(proposal => <section className="dm-setting-item" key={proposal._id}>
    {selected === proposal._id ? <MemoryProposalReview key={`${proposal._id}:${proposal.version}`} proposal={proposal} state={state} client={client} onClose={() => setSelected(null)} /> : <><p>{proposal.text}</p><button onClick={() => setSelected(proposal._id)}>Review memory</button></>}
  </section>)}</section>
}
