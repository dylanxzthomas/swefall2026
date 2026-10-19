import { useState } from 'react'
import type { FamilyFact } from '../../../shared/memory'
import type { DaymarkClient, DaymarkState } from './types'
import FamilyFactFields, { describeFamilyFact, emptyFamilyFact } from './FamilyFactFields'
import { MemoryProposalList } from './MemoryProposals'
export default function FamilyMemory({ state, client }: { state: DaymarkState; client: DaymarkClient }) {
  const [draft, setDraft] = useState<FamilyFact | null>(null), [editing, setEditing] = useState<{ id: string; version: number } | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn(); setDraft(null); setEditing(null) } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  const begin = (kind: FamilyFact['kind']) => { setEditing(null); setDraft(emptyFamilyFact(kind, state)) }
  return <details><summary>Schools, contacts, and routines</summary>
    <p>Only details you confirm are remembered. Routines help prepare requests; each send still needs approval.</p>
    <MemoryProposalList state={state} client={client} />
    {(state.facts ?? []).filter(f => f.key.startsWith('family:')).map(f => <section key={f._id} className="dm-setting-item"><p>{describeFamilyFact(f.value, state)}</p><p className="dm-muted">{f.source} · {f.scope} · {new Date(f.updatedAt).toLocaleDateString()}</p><div className="dm-actions"><button disabled={busy} onClick={() => { setEditing({ id: f._id, version: f.version }); setDraft(f.value) }}>Edit saved detail</button><button disabled={busy} onClick={() => void run(() => client.removeFact(f._id, f.version))}>Remove</button></div></section>)}
    {!draft && <div className="dm-actions"><button onClick={() => begin('school')}>Add school / class</button><button onClick={() => begin('contact')}>Add school contact</button><button onClick={() => begin('routine')}>Add weekly pickup routine</button><button onClick={() => begin('availability')}>Add availability for a date</button></div>}
    {draft && <section className="dm-fields">
      <FamilyFactFields value={draft} onChange={setDraft} state={state} />
      <div className="dm-actions"><button disabled={busy} onClick={() => void run(() => client.saveFact(draft, editing?.id, editing?.version))}>Confirm and save detail</button><button onClick={() => { setDraft(null); setEditing(null) }}>Discard edit</button></div>
    </section>}{error && <p role="alert">{error}</p>}
  </details>
}
