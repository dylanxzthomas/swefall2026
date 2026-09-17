import type Anthropic from '@anthropic-ai/sdk'
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod'
import * as z from 'zod/v4'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import type { Config } from '../config.js'
import { LOCAL_CALENDAR_PATH } from '../config.js'
import { Checkins, Commitments, Events, Facts, Notes, People, newId } from '../db.js'
import { appendToProfile } from '../profile.js'
import { emit } from '../bus.js'
import { addDays, addMinutes, fmtDateTime, fmtDay, startOfDay } from '../time.js'
import type { Attendee, TaskStep } from '../../shared/types.js'

export type RunnerTools = Parameters<Anthropic['beta']['messages']['toolRunner']>[0]['tools']

export interface ToolContext {
  cfg: Config
  checkinId: string | null
  steps: TaskStep[]
}

export interface LocalEvent {
  id: string
  title: string
  start: string
  end: string
  attendees?: { name: string; email?: string | null }[]
  location?: string | null
  description?: string | null
}

export function readLocalCalendar(): LocalEvent[] {
  if (!fs.existsSync(LOCAL_CALENDAR_PATH)) return []
  try {
    const v = JSON.parse(fs.readFileSync(LOCAL_CALENDAR_PATH, 'utf8'))
    return Array.isArray(v) ? (v as LocalEvent[]) : []
  } catch {
    return []
  }
}

export function writeLocalCalendar(list: LocalEvent[]): void {
  fs.writeFileSync(LOCAL_CALENDAR_PATH, JSON.stringify(list, null, 2) + '\n')
}

export function addLocalEvent(cfg: Config, e: Omit<LocalEvent, 'id'>): { id: string } {
  const id = newId()
  const list = readLocalCalendar()
  list.push({ id, ...e })
  writeLocalCalendar(list)
  const mine = new Set(cfg.user.emails.map((s) => s.toLowerCase()))
  const attendees: Attendee[] = (e.attendees ?? [])
    .filter((a) => !(a.email && mine.has(a.email.toLowerCase())))
    .map((a) => {
      const p = People.ensureFromAttendee({ name: a.name, email: a.email ?? null })
      return { name: a.name, email: a.email ?? null, person_id: p.id }
    })
  Events.upsert({
    source: 'local',
    uid: id,
    title: e.title,
    description: e.description ?? null,
    location: e.location ?? null,
    start: e.start,
    end: e.end,
    all_day: 0,
    attendees,
  })
  emit('calendar.refreshed', { imported: 1 })
  return { id }
}

function parseWhen(s: string): Date | null {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

export function buildTools(ctx: ToolContext) {
  const step = (tool: string, summary: string) => ctx.steps.push({ tool, summary, at: new Date().toISOString() })
  const A = ctx.cfg.assistant.name

  const lookupPerson = betaZodTool({
    name: 'lookup_person',
    description: 'Everything remembered about a person: who they are, what they want, facts with their sources, open commitments, and upcoming meetings with them.',
    inputSchema: z.object({ name: z.string().describe('Full or partial name') }),
    run: async ({ name }) => {
      const p = People.findByName(name)
      if (!p) {
        const near = People.search(name).slice(0, 5)
        return near.length ? `No exact match. Close names: ${near.map((x) => x.name).join(', ')}.` : `Nothing on file for ${name}.`
      }
      const facts = Facts.forPerson(p.id)
      const open = Commitments.forPerson(p.id).filter((c) => c.status === 'open')
      const events = Events.forPerson(p.id, new Date(), addDays(new Date(), 30))
      const lines = [
        `${p.name}${p.role || p.company ? ` (${[p.role, p.company].filter(Boolean).join(', ')})` : ''} [id ${p.id}]`,
        p.relationship ? `Relationship: ${p.relationship}` : '',
        p.last_contact_at ? `Last contact: ${fmtDay(p.last_contact_at)}` : 'Last contact: unknown',
        p.summary ? `Summary: ${p.summary}` : '',
        p.wants ? `Wants: ${p.wants}` : '',
        p.avoid ? `Avoid: ${p.avoid}` : '',
        p.notes ? `Notes: ${p.notes}` : '',
        ...facts.map((f) => `Fact (${fmtDay(f.created_at)}, ${f.source}): ${f.text}${f.evidence ? ` ["${f.evidence}"]` : ''}`),
        ...open.map((c) => `Open (${c.owner === 'me' ? 'owed to them' : 'they owe'}): ${c.text}${c.due ? `, due ${fmtDay(c.due)}` : ''} [commitment id ${c.id}]`),
        ...events.map((e) => `Upcoming: ${e.title}, ${fmtDateTime(e.start)}`),
      ].filter(Boolean)
      return lines.join('\n')
    },
  })

  const rememberPerson = betaZodTool({
    name: 'remember_about_person',
    description: `Save something ${ctx.cfg.user.name} said about a person. Creates the person if new. Only record what was actually said; put the exact words in evidence.`,
    inputSchema: z.object({
      name: z.string(),
      role: z.string().nullable().optional(),
      company: z.string().nullable().optional(),
      relationship: z.string().nullable().optional().describe(`Who they are to ${ctx.cfg.user.name}`),
      summary: z.string().nullable().optional().describe('One line'),
      wants: z.string().nullable().optional(),
      avoid: z.string().nullable().optional(),
      fact: z.string().nullable().optional().describe('A specific new fact'),
      evidence: z.string().nullable().optional().describe('The words the fact rests on'),
    }),
    run: async (input) => {
      let p = People.findByName(input.name) ?? People.create({ name: input.name })
      const patch: Record<string, string | null> = {}
      for (const k of ['role', 'company', 'relationship', 'summary', 'wants', 'avoid'] as const) {
        if (input[k] !== undefined && input[k] !== null && String(input[k]).trim()) patch[k] = String(input[k]).trim()
      }
      if (Object.keys(patch).length) p = People.update(p.id, patch)
      if (input.fact) Facts.add({ person_id: p.id, text: input.fact, source: 'conversation', evidence: input.evidence ?? null, confidence: 0.85 })
      step('remember_about_person', `Noted about ${p.name}: ${[...Object.keys(patch), input.fact ? 'a fact' : ''].filter(Boolean).join(', ')}`)
      emit('people.changed', { id: p.id })
      return `Saved. ${p.name} [id ${p.id}].`
    },
  })

  const listEvents = betaZodTool({
    name: 'list_events',
    description: 'Calendar events in a day range relative to today (0 = today).',
    inputSchema: z.object({ from_day: z.number().describe('Days from today, inclusive'), to_day: z.number().describe('Days from today, exclusive') }),
    run: async ({ from_day, to_day }) => {
      const s = addDays(startOfDay(new Date()), from_day)
      const e = addDays(startOfDay(new Date()), to_day)
      const evs = Events.between(s, e)
      if (!evs.length) return 'Nothing on the calendar in that range.'
      return evs.map((ev) => `${fmtDateTime(ev.start)} to ${ev.all_day ? 'all day' : fmtDateTime(ev.end)}: ${ev.title}${ev.attendees.length ? ` with ${ev.attendees.map((a) => a.name).join(', ')}` : ''} [event id ${ev.id}]`).join('\n')
    },
  })

  const createEvent = betaZodTool({
    name: 'create_event',
    description: `Put an event on ${ctx.cfg.user.name}'s local calendar (the one ${A} keeps; it does not write to Google Calendar). Times as ISO 8601 with offset.`,
    inputSchema: z.object({
      title: z.string(),
      start: z.string().describe('ISO 8601'),
      end: z.string().describe('ISO 8601'),
      attendees: z.array(z.object({ name: z.string(), email: z.string().nullable().optional() })).optional(),
      location: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
    }),
    run: async (input) => {
      const s = parseWhen(input.start)
      const e = parseWhen(input.end)
      if (!s || !e) return 'Could not parse those times. Use ISO 8601 with an offset.'
      const { id } = addLocalEvent(ctx.cfg, { title: input.title, start: s.toISOString(), end: e.toISOString(), attendees: input.attendees, location: input.location ?? null, description: input.notes ?? null })
      step('create_event', `Added "${input.title}" ${fmtDateTime(s)}`)
      return `Added "${input.title}" at ${fmtDateTime(s)} [event id ${id}].`
    },
  })

  const scheduleConversation = betaZodTool({
    name: 'schedule_conversation',
    description: `Schedule a conversation between ${A} and ${ctx.cfg.user.name} at a time: a reminder, a follow-up, a check-back. ${A} will ping and speak at that time.`,
    inputSchema: z.object({
      at: z.string().describe('ISO 8601 with offset'),
      reason: z.string().describe(`What ${A} should bring up, in ${A}'s own words`),
      title: z.string().optional().describe('Short title, a few words'),
    }),
    run: async ({ at, reason, title }) => {
      let when = parseWhen(at)
      if (!when) return 'Could not parse that time. Use ISO 8601 with an offset.'
      if (when.getTime() < Date.now()) when = addMinutes(new Date(), 1)
      const c = Checkins.create({ kind: 'adhoc', title: title?.trim() || reason.slice(0, 48), scheduled_for: when.toISOString(), reason })
      step('schedule_conversation', `Set "${c.title}" for ${fmtDateTime(when)}`)
      emit('checkin.scheduled', { checkin: c })
      return `Scheduled "${c.title}" for ${fmtDateTime(when)}.`
    },
  })

  const addCommitment = betaZodTool({
    name: 'add_commitment',
    description: `Record a promise: something ${ctx.cfg.user.name} owes someone (owner me) or someone owes ${ctx.cfg.user.name} (owner them).`,
    inputSchema: z.object({
      text: z.string(),
      owner: z.enum(['me', 'them']),
      person_name: z.string().nullable().optional(),
      due: z.string().nullable().optional().describe('ISO date or null'),
    }),
    run: async ({ text, owner, person_name, due }) => {
      const p = person_name ? People.findByName(person_name) ?? People.create({ name: person_name }) : null
      const d = due ? parseWhen(due) : null
      const c = Commitments.add({ text, owner, person_id: p?.id ?? null, due: d ? d.toISOString() : null, source_checkin_id: ctx.checkinId })
      step('add_commitment', `Logged: ${text}`)
      emit('commitments.changed', { id: c.id })
      return `Logged [commitment id ${c.id}].`
    },
  })

  const closeCommitment = betaZodTool({
    name: 'close_commitment',
    description: 'Mark a commitment done or dropped, by id (ids are in the world data).',
    inputSchema: z.object({ id: z.string(), status: z.enum(['done', 'dropped']) }),
    run: async ({ id, status }) => {
      const c = Commitments.get(id)
      if (!c) return 'No commitment with that id.'
      Commitments.close(id, status)
      step('close_commitment', `${status === 'done' ? 'Done' : 'Dropped'}: ${c.text}`)
      emit('commitments.changed', { id })
      return `Marked ${status}.`
    },
  })

  const draftEmail = betaZodTool({
    name: 'draft_email',
    description: `Open a draft in ${ctx.cfg.user.name}'s mail app with the recipient, subject, and body filled in. ${ctx.cfg.user.name} reads it and decides whether to send. Only when asked.`,
    inputSchema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
    run: async ({ to, subject, body }) => {
      const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
      if (process.platform === 'darwin') {
        await new Promise<void>((resolve, reject) => execFile('open', [url], (err) => (err ? reject(err) : resolve())))
        step('draft_email', `Opened a draft to ${to}: "${subject}"`)
        return `A draft to ${to} is open in Mail. Nothing has been sent.`
      }
      step('draft_email', `Drafted to ${to}: "${subject}"`)
      return `Draft ready (no mail app here):\nTo: ${to}\nSubject: ${subject}\n\n${body}`
    },
  })

  const updateProfile = betaZodTool({
    name: 'update_profile',
    description: `Add a line to what ${A} knows about ${ctx.cfg.user.name} themselves (not about other people). Sections: Work, People who matter right now, What a good week looks like, Things I keep putting off, How I like to be talked to.`,
    inputSchema: z.object({ section: z.string(), line: z.string() }),
    run: async ({ section, line }) => {
      appendToProfile(section, line)
      step('update_profile', `Profile, ${section}: ${line}`)
      emit('profile.changed', {})
      return 'Added.'
    },
  })

  const noteToSelf = betaZodTool({
    name: 'note_to_self',
    description: `A private note ${A} keeps for later: something to watch, a hunch to check. Not spoken.`,
    inputSchema: z.object({ text: z.string() }),
    run: async ({ text }) => {
      Notes.add('self', text)
      return 'Noted.'
    },
  })

  const tools: RunnerTools = [
    lookupPerson,
    rememberPerson,
    listEvents,
    createEvent,
    scheduleConversation,
    addCommitment,
    closeCommitment,
    draftEmail,
    updateProfile,
    noteToSelf,
  ]
  if (ctx.cfg.thinking.webResearch) tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 3 })
  return tools
}
