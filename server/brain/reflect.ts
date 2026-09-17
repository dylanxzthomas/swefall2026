import * as z from 'zod/v4'
import type { Config } from '../config.js'
import type { Brain } from '../llm.js'
import { Checkins, Events, KV, Notes, Observations, People } from '../db.js'
import { worldContext } from '../context.js'
import { reflectInstruction } from '../prompts.js'
import { emit } from '../bus.js'
import { addMinutes, isQuiet, startOfDay } from '../time.js'

const ReflectSchema = z.object({
  observations: z.array(
    z.object({
      kind: z.enum(['pattern', 'risk', 'opportunity', 'social', 'prediction', 'followup']),
      text: z.string(),
      evidence: z.array(z.string()),
      confidence: z.number(),
      surface_when: z.enum(['next_checkin', 'before_event', 'now', 'never']),
      event_id: z.string().nullable(),
      person_name: z.string().nullable(),
      expires_in_hours: z.number(),
    }),
  ),
  outcomes: z.array(z.object({ observation_id: z.string(), outcome: z.string() })),
  self_note: z.string().nullable(),
  request_conversation: z.object({ reason: z.string(), in_minutes: z.number() }).nullable(),
})

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

function tooSimilar(a: string, b: string): boolean {
  const na = normalize(a)
  const nb = normalize(b)
  if (na === nb) return true
  const wa = new Set(na.split(' '))
  const wb = new Set(nb.split(' '))
  let inter = 0
  for (const w of wa) if (wb.has(w)) inter++
  const jaccard = inter / (wa.size + wb.size - inter)
  return jaccard > 0.6
}

export interface ReflectResult {
  added: number
  outcomes: number
  requested: boolean
  skipped?: string
}

/** The dead-time pass: look at the next two days and decide whether anything is worth saying. Usually nothing is, and that is the point. */
export async function reflect(cfg: Config, brain: Brain): Promise<ReflectResult> {
  if (!brain.available) return { added: 0, outcomes: 0, requested: false, skipped: 'mock brain' }
  const now = new Date()
  const world = worldContext(cfg, { now })
  const out = await brain.structured(ReflectSchema, {
    purpose: 'reflect',
    effort: 'high',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `<world>\n${world}\n</world>` },
          { type: 'text', text: reflectInstruction(cfg) },
        ],
      },
    ],
    mock: { observations: [], outcomes: [], self_note: null, request_conversation: null },
  })
  KV.set('last_reflect_at', now.toISOString())
  if (!out) return { added: 0, outcomes: 0, requested: false, skipped: 'refusal' }

  const existing = [...Observations.queued(), ...Observations.surfacedSince(addMinutes(now, -48 * 60))]
  let added = 0
  for (const o of out.observations) {
    const text = o.text.trim()
    if (!text || o.evidence.length === 0) continue
    if (existing.some((e) => tooSimilar(e.text, text))) continue
    const person = o.person_name ? People.findByName(o.person_name) : undefined
    const event = o.event_id ? Events.get(o.event_id) : undefined
    const hours = Number.isFinite(o.expires_in_hours) && o.expires_in_hours > 0 ? Math.min(o.expires_in_hours, 24 * 14) : 72
    const obs = Observations.add({
      kind: o.kind,
      text,
      evidence: o.evidence.map((e) => e.trim()).filter(Boolean),
      confidence: Math.max(0, Math.min(1, o.confidence)),
      surface_when: o.surface_when,
      event_id: event?.id ?? null,
      person_id: person?.id ?? null,
      expires_at: event ? event.end : addMinutes(now, hours * 60).toISOString(),
    })
    existing.push(obs)
    added++
    if (o.surface_when === 'now') requestConversation(cfg, now, text, 1)
  }

  let outcomes = 0
  for (const oc of out.outcomes) {
    if (Observations.get(oc.observation_id)) {
      Observations.setOutcome(oc.observation_id, oc.outcome.trim())
      outcomes++
    }
  }
  if (out.self_note && out.self_note.trim()) Notes.add('self', out.self_note)

  let requested = false
  if (out.request_conversation && out.request_conversation.reason.trim()) {
    requested = requestConversation(cfg, now, out.request_conversation.reason, out.request_conversation.in_minutes)
  }
  emit('reflected', { added, outcomes, requested, at: now.toISOString() })
  return { added, outcomes, requested }
}

/** The assistant asking for a word. Rate-limited and never during quiet hours. */
function requestConversation(cfg: Config, now: Date, reason: string, inMinutes: number): boolean {
  if (isQuiet(cfg, now)) return false
  const already = Checkins.countOnDay('adhoc', startOfDay(now))
  if (already >= cfg.thinking.maxRequestedConversationsPerDay) return false
  const mins = Math.max(1, Math.min(Number.isFinite(inMinutes) ? inMinutes : 5, 240))
  const c = Checkins.create({ kind: 'adhoc', title: `A word from ${cfg.assistant.name}`, scheduled_for: addMinutes(now, mins).toISOString(), reason })
  emit('checkin.scheduled', { checkin: c })
  return true
}
