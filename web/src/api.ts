import type { AppConfig, Checkin, MemoryDTO, Message, Person, PersonDetail, SettingsDTO, StateDTO, Task } from '../../shared/types'

async function j<T>(input: string, init?: RequestInit): Promise<T> {
  const r = await fetch(input, { ...init, headers: { ...(init?.body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(init?.headers ?? {}) } })
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`
    try {
      const body = (await r.json()) as { error?: string }
      if (body.error) msg = body.error
    } catch {
      // keep the status text
    }
    throw new Error(msg)
  }
  return (await r.json()) as T
}

const post = <T,>(url: string, body?: unknown) => j<T>(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export interface TurnResult {
  message: Message
  audioUrl: string | null
  task: Task | null
}

export const api = {
  state: () => j<StateDTO>('/api/state'),
  checkin: (id: string) => j<{ checkin: Checkin; messages: Message[]; tasks: Task[] }>(`/api/checkins/${id}`),
  checkins: (from: string, to: string) => j<Checkin[]>(`/api/checkins?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  startCheckin: (id: string) => post<{ checkin: Checkin; messages: Message[] }>(`/api/checkins/${id}/start`),
  say: (id: string, text: string, via: 'voice' | 'text') => post<TurnResult>(`/api/checkins/${id}/say`, { text, via }),
  sayAnywhere: (text: string, via: 'voice' | 'text') => post<TurnResult & { checkin: Checkin }>('/api/say', { text, via }),
  endCheckin: (id: string) => post<{ checkin: Checkin }>(`/api/checkins/${id}/end`),
  skipCheckin: (id: string) => post<{ checkin: Checkin }>(`/api/checkins/${id}/skip`),
  talkNow: (reason?: string) => post<{ checkin: Checkin; messages: Message[] }>('/api/checkins', { reason }),
  think: () => post<{ result: unknown }>('/api/think'),
  refreshCalendar: () => post<{ at: string | null; errors: string[] }>('/api/calendar/refresh'),
  dismissObservation: (id: string) => post<{ ok: true }>(`/api/observations/${id}/dismiss`),

  people: (q?: string) => j<Person[]>(q ? `/api/people?q=${encodeURIComponent(q)}` : '/api/people'),
  person: (id: string) => j<PersonDetail>(`/api/people/${id}`),
  createPerson: (name: string) => post<Person>('/api/people', { name }),
  updatePerson: (id: string, patch: Partial<Person>) => j<Person>(`/api/people/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deletePerson: (id: string) => j<{ ok: true }>(`/api/people/${id}`, { method: 'DELETE' }),
  addFact: (id: string, text: string) => post<unknown>(`/api/people/${id}/facts`, { text }),
  deleteFact: (id: string) => j<{ ok: true }>(`/api/facts/${id}`, { method: 'DELETE' }),
  addCommitment: (body: { text: string; owner: 'me' | 'them'; person_id?: string | null; due?: string | null }) => post<unknown>('/api/commitments', body),
  closeCommitment: (id: string, status: 'done' | 'dropped' = 'done') => post<{ ok: true }>(`/api/commitments/${id}/close`, { status }),
  reopenCommitment: (id: string) => post<{ ok: true }>(`/api/commitments/${id}/reopen`),

  memory: () => j<MemoryDTO>('/api/memory'),
  saveProfile: (text: string) => j<{ ok: true }>('/api/memory/profile', { method: 'PUT', body: JSON.stringify({ text }) }),
  tasks: () => j<Task[]>('/api/tasks'),

  settings: () => j<SettingsDTO>('/api/settings'),
  saveSettings: (patch: Partial<AppConfig> | Record<string, unknown>) => j<SettingsDTO>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  voices: () => j<{ provider: string; voices: { id: string; name: string; note?: string }[]; error?: string }>('/api/settings/voices'),
  testVoice: (text?: string) => post<{ url: string; provider: string }>('/api/settings/test-voice', { text }),

  stt: async (blob: Blob) => {
    const fd = new FormData()
    fd.append('audio', blob, 'audio.webm')
    return j<{ text: string }>('/api/stt', { method: 'POST', body: fd })
  },
}

export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
export const fmtDay = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
export const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString()
export const relTime = (iso: string) => {
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60_000)
  const a = Math.abs(mins)
  const s = a < 1 ? 'now' : a < 60 ? `${a} min` : a < 36 * 60 ? `${Math.round(a / 60)} h` : `${Math.round(a / 1440)} d`
  if (s === 'now') return s
  return mins < 0 ? `${s} ago` : `in ${s}`
}
