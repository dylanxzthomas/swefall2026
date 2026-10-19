import { useRef, useState } from 'react'
import type { DaymarkClient, DaymarkState } from './types'

export default function WorkingMemorySettings({ state, client }: { state: Pick<DaymarkState, 'workingMemory' | 'storage'>; client: Pick<DaymarkClient, 'resetWorkingMemory'> }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), pending = useRef(false)
  if (state.storage === 'device' || !state.workingMemory || !client.resetWorkingMemory) return null
  const clear = async () => {
    if (pending.current) return
    pending.current = true; setBusy(true); setNotice('')
    try { await client.resetWorkingMemory!(state.workingMemory!.version); setNotice('Older working context cleared. Recent conversation remains.') }
    catch { setNotice('Working context could not be cleared. Open the latest settings and try again.') }
    finally { pending.current = false; setBusy(false) }
  }
  return <section aria-label="Private working context"><p>Conversation stays private to you. Sola uses recent messages and up to six temporary excerpts from earlier messages to follow along. These expire with the originals and do not become confirmed family facts.</p><p className="dm-muted">{state.workingMemory.excerptCount} older {state.workingMemory.excerptCount === 1 ? 'excerpt' : 'excerpts'} in use. Clearing stops earlier messages from being selected again; recent conversation, saved work and confirmed family details remain.</p><button disabled={busy} onClick={() => void clear()}>{busy ? 'Clearing…' : 'Clear older working context'}</button>{notice && <p role="status">{notice}</p>}</section>
}
