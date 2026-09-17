import * as z from 'zod/v4'
import type { Config } from '../config.js'
import type { Brain } from '../llm.js'
import { Checkins, Commitments, Facts, KV, Messages, Observations, People } from '../db.js'
import { worldForCheckin } from './converse.js'
import { extractInstruction } from '../prompts.js'
import { appendToProfile } from '../profile.js'
import { emit } from '../bus.js'
import type { Checkin } from '../../shared/types.js'

const ExtractSchema = z.object({
  people: z.array(
    z.object({
      name: z.string(),
      role: z.string().nullable(),
      company: z.string().nullable(),
      relationship: z.string().nullable(),
      wants: z.string().nullable(),
      avoid: z.string().nullable(),
      summary: z.string().nullable(),
      facts: z.array(z.object({ text: z.string(), evidence: z.string() })),
    }),
  ),
  commitments: z.array(z.object({ text: z.string(), owner: z.enum(['me', 'them']), person_name: z.string().nullable(), due: z.string().nullable() })),
  profile: z.array(z.object({ section: z.string(), line: z.string() })),
  outcomes: z.array(z.object({ observation_id: z.string(), outcome: z.string() })),
  summary: z.string(),
})

/** Close a conversation and fold what was said into memory. Runs whether the conversation was finished, skipped, or missed. */
export async function endCheckin(cfg: Config, brain: Brain, checkin: Checkin, status: 'done' | 'skipped' | 'missed'): Promise<Checkin> {
  const userTurns = Messages.countUser(checkin.id)
  let summary: string | null = null
  if (status === 'missed') summary = 'No conversation.'
  if (status === 'skipped') summary = 'Skipped.'

  if (userTurns > 0 && brain.available) {
    try {
      const transcript = Messages.forCheckin(checkin.id)
        .map((m) => `${m.role === 'user' ? cfg.user.name : cfg.assistant.name}: ${m.text}`)
        .join('\n')
      const out = await brain.structured(ExtractSchema, {
        purpose: `extract:${checkin.kind}`,
        effort: 'medium',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: `<world>\n${worldForCheckin(cfg, checkin)}\n</world>` },
              { type: 'text', text: `<transcript>\n${transcript}\n</transcript>\n\n${extractInstruction(cfg)}` },
            ],
          },
        ],
        mock: { people: [], commitments: [], profile: [], outcomes: [], summary: '' },
      })
      if (out) {
        for (const p of out.people) {
          if (!p.name.trim()) continue
          const hasSubstance = p.role || p.company || p.relationship || p.wants || p.avoid || p.summary || p.facts.length
          if (!hasSubstance) continue
          let person = People.findByName(p.name)
          if (!person) person = People.create({ name: p.name })
          const patch: Record<string, string> = {}
          for (const k of ['role', 'company', 'relationship', 'wants', 'avoid', 'summary'] as const) if (p[k] && p[k]!.trim()) patch[k] = p[k]!.trim()
          if (Object.keys(patch).length) People.update(person.id, patch)
          for (const f of p.facts) if (f.text.trim()) Facts.add({ person_id: person.id, text: f.text, source: `conversation ${checkin.title}`, evidence: f.evidence || null, confidence: 0.8 })
          People.touch(person.id, new Date().toISOString())
        }
        for (const c of out.commitments) {
          if (!c.text.trim()) continue
          const person = c.person_name ? People.findByName(c.person_name) ?? People.create({ name: c.person_name }) : null
          const due = c.due ? new Date(c.due) : null
          Commitments.add({ text: c.text, owner: c.owner, person_id: person?.id ?? null, due: due && !Number.isNaN(due.getTime()) ? due.toISOString() : null, source_checkin_id: checkin.id })
        }
        for (const line of out.profile) if (line.line.trim()) appendToProfile(line.section || 'Work', line.line)
        for (const oc of out.outcomes) if (Observations.get(oc.observation_id)) Observations.setOutcome(oc.observation_id, oc.outcome)
        if (out.summary.trim()) summary = out.summary.trim()
        emit('memory.changed', { checkinId: checkin.id })
      }
    } catch (err) {
      console.warn(`[extract] ${checkin.title}: ${(err as Error).message}`)
    }
  } else if (userTurns > 0 && summary === null) {
    summary = `${userTurns} exchange${userTurns === 1 ? '' : 's'}; memory not updated (mock brain).`
  }

  if (checkin.kind === 'onboarding' && status === 'done') KV.set('onboarded', '1')
  const ended = Checkins.setStatus(checkin.id, status, { ended_at: new Date().toISOString(), summary })
  emit('checkin.ended', { checkin: ended })
  return ended
}
