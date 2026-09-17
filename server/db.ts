import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import crypto from 'node:crypto'
import { DATA_DIR } from './config.js'
import type {
  Attendee,
  CalEvent,
  Checkin,
  CheckinKind,
  CheckinStatus,
  Commitment,
  Fact,
  Message,
  Note,
  Observation,
  Person,
  Script,
  Task,
  TaskStep,
} from '../shared/types.js'

type P = null | number | string | bigint | Uint8Array
type Row = Record<string, unknown>

export const db = new DatabaseSync(path.join(DATA_DIR, 'wren.sqlite'))
db.exec('PRAGMA journal_mode=WAL')

db.exec(`
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]', emails TEXT NOT NULL DEFAULT '[]',
  relationship TEXT, role TEXT, company TEXT, summary TEXT, wants TEXT, avoid TEXT, notes TEXT,
  last_contact_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY, person_id TEXT, text TEXT NOT NULL, source TEXT NOT NULL, evidence TEXT,
  confidence REAL NOT NULL DEFAULT 0.7, created_at TEXT NOT NULL, retired_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, uid TEXT NOT NULL, title TEXT NOT NULL, description TEXT, location TEXT,
  start TEXT NOT NULL, end TEXT NOT NULL, all_day INTEGER NOT NULL DEFAULT 0, attendees TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL, UNIQUE(source, uid)
);
CREATE INDEX IF NOT EXISTS events_start ON events(start);
CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, event_id TEXT, title TEXT NOT NULL, scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL, script TEXT, audio_path TEXT, summary TEXT, reason TEXT,
  created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT
);
CREATE INDEX IF NOT EXISTS checkins_sched ON checkins(scheduled_for);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, checkin_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, audio_path TEXT,
  meta TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_checkin ON messages(checkin_id, created_at);
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL, surface_when TEXT NOT NULL, event_id TEXT, person_id TEXT, status TEXT NOT NULL,
  outcome TEXT, created_at TEXT NOT NULL, surfaced_at TEXT, expires_at TEXT
);
CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, owner TEXT NOT NULL, person_id TEXT, due TEXT, status TEXT NOT NULL,
  source_checkin_id TEXT, created_at TEXT NOT NULL, closed_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, checkin_id TEXT, request TEXT NOT NULL, status TEXT NOT NULL, steps TEXT NOT NULL DEFAULT '[]',
  result TEXT, created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY, day TEXT NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL,
  input_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_day ON usage(day);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`)

export const newId = (): string => crypto.randomUUID()
export const nowIso = (): string => new Date().toISOString()

export function all<T = Row>(sql: string, ...params: P[]): T[] {
  return db.prepare(sql).all(...params) as T[]
}
export function get<T = Row>(sql: string, ...params: P[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined
}
export function run(sql: string, ...params: P[]) {
  return db.prepare(sql).run(...params)
}

function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string') return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

const norm = (s: string) => s.trim().toLowerCase()

// ---------- People ----------

function toPerson(r: Row): Person {
  return {
    ...(r as unknown as Person),
    aliases: json<string[]>(r.aliases, []),
    emails: json<string[]>(r.emails, []),
  }
}

export const People = {
  all(): Person[] {
    return all('SELECT * FROM people ORDER BY name COLLATE NOCASE').map(toPerson)
  },
  get(id: string): Person | undefined {
    const r = get('SELECT * FROM people WHERE id = ?', id)
    return r && toPerson(r)
  },
  findByEmail(email: string): Person | undefined {
    const r = get('SELECT * FROM people WHERE emails LIKE ?', `%"${norm(email)}"%`)
    return r && toPerson(r)
  },
  findByName(name: string): Person | undefined {
    const n = norm(name)
    if (!n) return undefined
    const exact = get('SELECT * FROM people WHERE lower(name) = ?', n)
    if (exact) return toPerson(exact)
    const alias = all('SELECT * FROM people WHERE lower(aliases) LIKE ?', `%"${n}"%`)
    if (alias.length === 1) return toPerson(alias[0])
    const first = all('SELECT * FROM people WHERE lower(name) LIKE ?', `${n} %`)
    if (first.length === 1) return toPerson(first[0])
    const contains = all('SELECT * FROM people WHERE lower(name) LIKE ?', `%${n}%`)
    if (contains.length === 1) return toPerson(contains[0])
    return undefined
  },
  search(q: string): Person[] {
    const n = `%${norm(q)}%`
    return all(
      'SELECT * FROM people WHERE lower(name) LIKE ? OR lower(company) LIKE ? OR lower(role) LIKE ? ORDER BY name COLLATE NOCASE',
      n,
      n,
      n,
    ).map(toPerson)
  },
  create(p: Partial<Person> & { name: string }): Person {
    const id = p.id ?? newId()
    const t = nowIso()
    run(
      `INSERT INTO people (id,name,aliases,emails,relationship,role,company,summary,wants,avoid,notes,last_contact_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      p.name.trim(),
      JSON.stringify(p.aliases ?? []),
      JSON.stringify((p.emails ?? []).map(norm)),
      p.relationship ?? null,
      p.role ?? null,
      p.company ?? null,
      p.summary ?? null,
      p.wants ?? null,
      p.avoid ?? null,
      p.notes ?? null,
      p.last_contact_at ?? null,
      t,
      t,
    )
    return People.get(id)!
  },
  update(id: string, patch: Partial<Person>): Person {
    const cur = People.get(id)
    if (!cur) throw new Error(`no person ${id}`)
    const next = { ...cur, ...patch }
    run(
      `UPDATE people SET name=?, aliases=?, emails=?, relationship=?, role=?, company=?, summary=?, wants=?, avoid=?, notes=?, last_contact_at=?, updated_at=? WHERE id=?`,
      next.name,
      JSON.stringify(next.aliases ?? []),
      JSON.stringify((next.emails ?? []).map(norm)),
      next.relationship ?? null,
      next.role ?? null,
      next.company ?? null,
      next.summary ?? null,
      next.wants ?? null,
      next.avoid ?? null,
      next.notes ?? null,
      next.last_contact_at ?? null,
      nowIso(),
      id,
    )
    return People.get(id)!
  },
  /** Find or create a person from a calendar attendee. */
  ensureFromAttendee(a: Attendee): Person {
    if (a.email) {
      const byEmail = People.findByEmail(a.email)
      if (byEmail) return byEmail
    }
    const byName = a.name && !a.name.includes('@') ? People.findByName(a.name) : undefined
    if (byName) {
      if (a.email && !byName.emails.includes(norm(a.email))) People.update(byName.id, { emails: [...byName.emails, a.email] })
      return byName
    }
    return People.create({ name: a.name || a.email || 'Unknown', emails: a.email ? [a.email] : [] })
  },
  touch(id: string, at: string): void {
    run('UPDATE people SET last_contact_at = ?, updated_at = ? WHERE id = ? AND (last_contact_at IS NULL OR last_contact_at < ?)', at, nowIso(), id, at)
  },
  remove(id: string): void {
    run('DELETE FROM people WHERE id = ?', id)
    run('DELETE FROM facts WHERE person_id = ?', id)
  },
}

// ---------- Facts ----------

export const Facts = {
  forPerson(personId: string): Fact[] {
    return all<Fact>('SELECT * FROM facts WHERE person_id = ? AND retired_at IS NULL ORDER BY created_at DESC', personId)
  },
  recent(n = 50): Fact[] {
    return all<Fact>('SELECT * FROM facts WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT ?', n)
  },
  add(f: { person_id?: string | null; text: string; source: string; evidence?: string | null; confidence?: number }): Fact {
    const id = newId()
    run(
      'INSERT INTO facts (id, person_id, text, source, evidence, confidence, created_at) VALUES (?,?,?,?,?,?,?)',
      id,
      f.person_id ?? null,
      f.text.trim(),
      f.source,
      f.evidence ?? null,
      f.confidence ?? 0.7,
      nowIso(),
    )
    return get<Fact>('SELECT * FROM facts WHERE id = ?', id)!
  },
  retire(id: string): void {
    run('UPDATE facts SET retired_at = ? WHERE id = ?', nowIso(), id)
  },
}

// ---------- Events ----------

function toEvent(r: Row): CalEvent {
  return { ...(r as unknown as CalEvent), attendees: json<Attendee[]>(r.attendees, []) }
}

export const Events = {
  get(id: string): CalEvent | undefined {
    const r = get('SELECT * FROM events WHERE id = ?', id)
    return r && toEvent(r)
  },
  between(from: Date, to: Date): CalEvent[] {
    return all('SELECT * FROM events WHERE end > ? AND start < ? ORDER BY start', from.toISOString(), to.toISOString()).map(toEvent)
  },
  forPerson(personId: string, from: Date, to: Date): CalEvent[] {
    return Events.between(from, to).filter((e) => e.attendees.some((a) => a.person_id === personId))
  },
  upsert(e: Omit<CalEvent, 'id' | 'updated_at'> & { id?: string }): { event: CalEvent; changed: boolean } {
    const existing = get('SELECT * FROM events WHERE source = ? AND uid = ?', e.source, e.uid)
    const t = nowIso()
    if (existing) {
      const prev = toEvent(existing)
      const changed =
        prev.start !== e.start || prev.end !== e.end || prev.title !== e.title || JSON.stringify(prev.attendees) !== JSON.stringify(e.attendees)
      run(
        'UPDATE events SET title=?, description=?, location=?, start=?, end=?, all_day=?, attendees=?, updated_at=? WHERE id=?',
        e.title,
        e.description ?? null,
        e.location ?? null,
        e.start,
        e.end,
        e.all_day,
        JSON.stringify(e.attendees),
        changed ? t : prev.updated_at,
        prev.id,
      )
      return { event: Events.get(prev.id)!, changed }
    }
    const id = e.id ?? newId()
    run(
      'INSERT INTO events (id, source, uid, title, description, location, start, end, all_day, attendees, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id,
      e.source,
      e.uid,
      e.title,
      e.description ?? null,
      e.location ?? null,
      e.start,
      e.end,
      e.all_day,
      JSON.stringify(e.attendees),
      t,
    )
    return { event: Events.get(id)!, changed: true }
  },
  pruneMissing(source: 'ics' | 'local', keepUids: Set<string>, from: Date, to: Date): string[] {
    const rows = all<{ id: string; uid: string }>(
      'SELECT id, uid FROM events WHERE source = ? AND end > ? AND start < ?',
      source,
      from.toISOString(),
      to.toISOString(),
    )
    const removed: string[] = []
    for (const r of rows) {
      if (!keepUids.has(r.uid)) {
        run('DELETE FROM events WHERE id = ?', r.id)
        removed.push(r.id)
      }
    }
    return removed
  },
}

// ---------- Check-ins ----------

function toCheckin(r: Row): Checkin {
  return { ...(r as unknown as Checkin), script: json<Script | null>(r.script, null) }
}

export const Checkins = {
  get(id: string): Checkin | undefined {
    const r = get('SELECT * FROM checkins WHERE id = ?', id)
    return r && toCheckin(r)
  },
  between(from: Date, to: Date): Checkin[] {
    return all('SELECT * FROM checkins WHERE scheduled_for >= ? AND scheduled_for < ? ORDER BY scheduled_for', from.toISOString(), to.toISOString()).map(toCheckin)
  },
  live(): Checkin | undefined {
    const r = get("SELECT * FROM checkins WHERE status = 'live' ORDER BY started_at DESC LIMIT 1")
    return r && toCheckin(r)
  },
  allLive(): Checkin[] {
    return all("SELECT * FROM checkins WHERE status = 'live' ORDER BY started_at").map(toCheckin)
  },
  findKindOnDay(kind: CheckinKind, day: Date): Checkin | undefined {
    const from = new Date(day.getFullYear(), day.getMonth(), day.getDate()).toISOString()
    const to = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).toISOString()
    const r = get('SELECT * FROM checkins WHERE kind = ? AND scheduled_for >= ? AND scheduled_for < ? LIMIT 1', kind, from, to)
    return r && toCheckin(r)
  },
  byEventAndKind(eventId: string, kind: CheckinKind): Checkin | undefined {
    const r = get('SELECT * FROM checkins WHERE event_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1', eventId, kind)
    return r && toCheckin(r)
  },
  due(now: Date): Checkin[] {
    return all("SELECT * FROM checkins WHERE status IN ('scheduled','prepared') AND scheduled_for <= ? ORDER BY scheduled_for", now.toISOString()).map(toCheckin)
  },
  upcomingUnprepared(now: Date, withinMinutes: number): Checkin[] {
    const to = new Date(now.getTime() + withinMinutes * 60_000).toISOString()
    return all("SELECT * FROM checkins WHERE status = 'scheduled' AND scheduled_for <= ? ORDER BY scheduled_for", to).map(toCheckin)
  },
  next(now: Date): Checkin | undefined {
    const r = get("SELECT * FROM checkins WHERE status IN ('scheduled','prepared') AND scheduled_for > ? ORDER BY scheduled_for LIMIT 1", now.toISOString())
    return r && toCheckin(r)
  },
  recentEnded(n = 5): Checkin[] {
    return all("SELECT * FROM checkins WHERE status IN ('done','missed','skipped') ORDER BY scheduled_for DESC LIMIT ?", n).map(toCheckin)
  },
  countKindSince(kind: CheckinKind, since: Date): number {
    return get<{ n: number }>('SELECT COUNT(*) AS n FROM checkins WHERE kind = ? AND created_at >= ?', kind, since.toISOString())!.n
  },
  countOnDay(kind: CheckinKind, day: Date): number {
    const from = new Date(day.getFullYear(), day.getMonth(), day.getDate()).toISOString()
    const to = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).toISOString()
    return get<{ n: number }>('SELECT COUNT(*) AS n FROM checkins WHERE kind = ? AND scheduled_for >= ? AND scheduled_for < ?', kind, from, to)!.n
  },
  create(c: { kind: CheckinKind; title: string; scheduled_for: string; event_id?: string | null; reason?: string | null }): Checkin {
    const id = newId()
    run(
      "INSERT INTO checkins (id, kind, event_id, title, scheduled_for, status, reason, created_at) VALUES (?,?,?,?,?,'scheduled',?,?)",
      id,
      c.kind,
      c.event_id ?? null,
      c.title,
      c.scheduled_for,
      c.reason ?? null,
      nowIso(),
    )
    return Checkins.get(id)!
  },
  setStatus(id: string, status: CheckinStatus, extra: { started_at?: string; ended_at?: string; summary?: string | null } = {}): Checkin {
    const cur = Checkins.get(id)!
    run(
      'UPDATE checkins SET status = ?, started_at = ?, ended_at = ?, summary = ? WHERE id = ?',
      status,
      extra.started_at ?? cur.started_at,
      extra.ended_at ?? cur.ended_at,
      extra.summary === undefined ? cur.summary : extra.summary,
      id,
    )
    return Checkins.get(id)!
  },
  setScript(id: string, script: Script | null, audioPath: string | null): Checkin {
    const cur = Checkins.get(id)!
    const status = cur.status === 'scheduled' && script ? 'prepared' : cur.status === 'prepared' && !script ? 'scheduled' : cur.status
    run('UPDATE checkins SET script = ?, audio_path = ?, status = ? WHERE id = ?', script ? JSON.stringify(script) : null, audioPath, status, id)
    return Checkins.get(id)!
  },
  reschedule(id: string, scheduledFor: string): void {
    run("UPDATE checkins SET scheduled_for = ?, script = NULL, audio_path = NULL, status = 'scheduled' WHERE id = ?", scheduledFor, id)
  },
}

// ---------- Messages ----------

function toMessage(r: Row): Message {
  return { ...(r as unknown as Message), meta: json<Record<string, unknown>>(r.meta, {}) }
}

export const Messages = {
  forCheckin(checkinId: string): Message[] {
    return all('SELECT * FROM messages WHERE checkin_id = ? ORDER BY created_at, rowid', checkinId).map(toMessage)
  },
  add(checkinId: string, role: 'user' | 'assistant', text: string, audioPath: string | null = null, meta: Record<string, unknown> = {}): Message {
    const id = newId()
    run('INSERT INTO messages (id, checkin_id, role, text, audio_path, meta, created_at) VALUES (?,?,?,?,?,?,?)', id, checkinId, role, text, audioPath, JSON.stringify(meta), nowIso())
    return toMessage(get('SELECT * FROM messages WHERE id = ?', id)!)
  },
  countUser(checkinId: string): number {
    return get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE checkin_id = ? AND role = 'user'", checkinId)!.n
  },
  lastAt(checkinId: string): string | null {
    return get<{ t: string | null }>('SELECT MAX(created_at) AS t FROM messages WHERE checkin_id = ?', checkinId)?.t ?? null
  },
}

// ---------- Observations ----------

function toObservation(r: Row): Observation {
  return { ...(r as unknown as Observation), evidence: json<string[]>(r.evidence, []) }
}

export const Observations = {
  get(id: string): Observation | undefined {
    const r = get('SELECT * FROM observations WHERE id = ?', id)
    return r && toObservation(r)
  },
  queued(): Observation[] {
    return all("SELECT * FROM observations WHERE status = 'queued' ORDER BY created_at DESC").map(toObservation)
  },
  forEvent(eventId: string): Observation[] {
    return all("SELECT * FROM observations WHERE event_id = ? AND status IN ('queued','surfaced') ORDER BY created_at DESC", eventId).map(toObservation)
  },
  forPerson(personId: string): Observation[] {
    return all('SELECT * FROM observations WHERE person_id = ? ORDER BY created_at DESC LIMIT 20', personId).map(toObservation)
  },
  recent(n = 30): Observation[] {
    return all('SELECT * FROM observations ORDER BY created_at DESC LIMIT ?', n).map(toObservation)
  },
  surfacedSince(since: Date): Observation[] {
    return all("SELECT * FROM observations WHERE status = 'surfaced' AND surfaced_at >= ? ORDER BY surfaced_at DESC", since.toISOString()).map(toObservation)
  },
  add(o: Omit<Observation, 'id' | 'status' | 'outcome' | 'created_at' | 'surfaced_at'>): Observation {
    const id = newId()
    run(
      "INSERT INTO observations (id, kind, text, evidence, confidence, surface_when, event_id, person_id, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,'queued',?,?)",
      id,
      o.kind,
      o.text.trim(),
      JSON.stringify(o.evidence),
      o.confidence,
      o.surface_when,
      o.event_id ?? null,
      o.person_id ?? null,
      nowIso(),
      o.expires_at ?? null,
    )
    return Observations.get(id)!
  },
  markSurfaced(ids: string[]): void {
    const t = nowIso()
    for (const id of ids) run("UPDATE observations SET status = 'surfaced', surfaced_at = ? WHERE id = ? AND status = 'queued'", t, id)
  },
  setStatus(id: string, status: Observation['status']): void {
    run('UPDATE observations SET status = ? WHERE id = ?', status, id)
  },
  setOutcome(id: string, outcome: string): void {
    run('UPDATE observations SET outcome = ? WHERE id = ?', outcome, id)
  },
  expire(now: Date): number {
    return Number(run("UPDATE observations SET status = 'expired' WHERE status = 'queued' AND expires_at IS NOT NULL AND expires_at < ?", now.toISOString()).changes)
  },
}

// ---------- Commitments ----------

export const Commitments = {
  get(id: string): Commitment | undefined {
    return get<Commitment>('SELECT * FROM commitments WHERE id = ?', id)
  },
  open(): Commitment[] {
    return all<Commitment>("SELECT * FROM commitments WHERE status = 'open' ORDER BY COALESCE(due, '9999') , created_at")
  },
  recent(n = 30): Commitment[] {
    return all<Commitment>('SELECT * FROM commitments ORDER BY created_at DESC LIMIT ?', n)
  },
  forPerson(personId: string): Commitment[] {
    return all<Commitment>('SELECT * FROM commitments WHERE person_id = ? ORDER BY status, created_at DESC', personId)
  },
  add(c: { text: string; owner: 'me' | 'them'; person_id?: string | null; due?: string | null; source_checkin_id?: string | null }): Commitment {
    const id = newId()
    run(
      "INSERT INTO commitments (id, text, owner, person_id, due, status, source_checkin_id, created_at) VALUES (?,?,?,?,?,'open',?,?)",
      id,
      c.text.trim(),
      c.owner,
      c.person_id ?? null,
      c.due ?? null,
      c.source_checkin_id ?? null,
      nowIso(),
    )
    return Commitments.get(id)!
  },
  close(id: string, status: 'done' | 'dropped'): void {
    run('UPDATE commitments SET status = ?, closed_at = ? WHERE id = ?', status, nowIso(), id)
  },
  reopen(id: string): void {
    run("UPDATE commitments SET status = 'open', closed_at = NULL WHERE id = ?", id)
  },
}

// ---------- Tasks ----------

function toTask(r: Row): Task {
  return { ...(r as unknown as Task), steps: json<TaskStep[]>(r.steps, []) }
}

export const Tasks = {
  create(t: { checkin_id?: string | null; request: string }): Task {
    const id = newId()
    run("INSERT INTO tasks (id, checkin_id, request, status, created_at) VALUES (?,?,?,'running',?)", id, t.checkin_id ?? null, t.request, nowIso())
    return Tasks.get(id)!
  },
  get(id: string): Task | undefined {
    const r = get('SELECT * FROM tasks WHERE id = ?', id)
    return r && toTask(r)
  },
  finish(id: string, status: 'done' | 'failed', steps: TaskStep[], result: string | null): Task {
    run('UPDATE tasks SET status = ?, steps = ?, result = ?, finished_at = ? WHERE id = ?', status, JSON.stringify(steps), result, nowIso(), id)
    return Tasks.get(id)!
  },
  recent(n = 20): Task[] {
    return all('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?', n).map(toTask)
  },
  forCheckin(checkinId: string): Task[] {
    return all('SELECT * FROM tasks WHERE checkin_id = ? ORDER BY created_at', checkinId).map(toTask)
  },
}

// ---------- Notes ----------

export const Notes = {
  add(kind: 'self' | 'user', text: string): Note {
    const id = newId()
    run('INSERT INTO notes (id, kind, text, created_at) VALUES (?,?,?,?)', id, kind, text.trim(), nowIso())
    return get<Note>('SELECT * FROM notes WHERE id = ?', id)!
  },
  recent(kind: 'self' | 'user', n = 10): Note[] {
    return all<Note>('SELECT * FROM notes WHERE kind = ? ORDER BY created_at DESC LIMIT ?', kind, n)
  },
}

// ---------- Usage ----------

export const Usage = {
  add(u: { day: string; model: string; purpose: string; input: number; cacheRead: number; cacheWrite: number; output: number; cost: number }): void {
    run(
      'INSERT INTO usage (id, day, model, purpose, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      newId(),
      u.day,
      u.model,
      u.purpose,
      u.input,
      u.cacheRead,
      u.cacheWrite,
      u.output,
      u.cost,
      nowIso(),
    )
  },
  today(day: string): { cost: number; calls: number } {
    const r = get<{ cost: number | null; calls: number }>('SELECT SUM(cost_usd) AS cost, COUNT(*) AS calls FROM usage WHERE day = ?', day)
    return { cost: r?.cost ?? 0, calls: r?.calls ?? 0 }
  },
}

// ---------- KV ----------

export const KV = {
  get(key: string): string | null {
    return get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value ?? null
  },
  set(key: string, value: string): void {
    run('INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  },
}

/** The most recent moment anything the brain cares about changed. Used to decide whether dead-time thinking has new material. */
export function latestChangeAt(): string | null {
  const r = get<{ t: string | null }>(`
    SELECT MAX(t) AS t FROM (
      SELECT MAX(created_at) AS t FROM messages
      UNION ALL SELECT MAX(updated_at) FROM events
      UNION ALL SELECT MAX(created_at) FROM commitments
      UNION ALL SELECT MAX(created_at) FROM facts
      UNION ALL SELECT MAX(updated_at) FROM people
      UNION ALL SELECT MAX(ended_at) FROM checkins
    )`)
  return r?.t ?? null
}
