import * as z from 'zod/v4'
import type { Config } from '../config.js'
import { Brain, BudgetExhausted, BrainUnavailable, forSpeech } from '../llm.js'
import type { TTS } from '../voice/tts.js'
import { Checkins, Events, Observations } from '../db.js'
import { worldContext } from '../context.js'
import { prepareInstruction } from '../prompts.js'
import { emit } from '../bus.js'
import type { Checkin, Script } from '../../shared/types.js'

export const ScriptSchema = z.object({
  opener: z.string(),
  points: z.array(z.object({ text: z.string(), evidence: z.string() })),
  people: z.array(z.object({ name: z.string(), brief: z.string() })),
  questions: z.array(z.string()),
  quiet: z.boolean(),
  observation_ids: z.array(z.string()),
})

function fallbackScript(cfg: Config, checkin: Checkin, err: unknown): Script {
  const A = cfg.assistant.name
  let opener: string
  if (err instanceof BrainUnavailable) opener = `[mock] ${A} would open your ${checkin.title.toLowerCase()} here. Put ANTHROPIC_API_KEY in .env and restart to hear the real thing.`
  else if (err instanceof BudgetExhausted) opener = `I'm past today's budget, so I couldn't prepare this one. Tell me what you need and I'll do what I can.`
  else opener = `Something went wrong while I was preparing this. I'm here. Tell me what you need.`
  return { opener, points: [], people: [], questions: [], quiet: true, observation_ids: [] }
}

/** Dead-time work: think through the conversation before it happens, and pre-render the opening line so it starts the moment it's due. */
export async function prepareCheckin(cfg: Config, brain: Brain, tts: TTS, checkin: Checkin): Promise<Checkin> {
  const event = checkin.event_id ? Events.get(checkin.event_id) : undefined
  emit('checkin.preparing', { id: checkin.id, title: checkin.title })
  let script: Script
  try {
    const world = worldContext(cfg, { checkin, event })
    const out = await brain.structured(ScriptSchema, {
      purpose: `prepare:${checkin.kind}`,
      effort: 'high',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `<world>\n${world}\n</world>` },
            { type: 'text', text: prepareInstruction(cfg, checkin, event) },
          ],
        },
      ],
      mock: fallbackScript(cfg, checkin, new BrainUnavailable()),
    })
    script = out ?? fallbackScript(cfg, checkin, new Error('refusal'))
    script.opener = forSpeech(script.opener)
    // Only keep observation ids that exist and are still queued.
    const queued = new Set(Observations.queued().map((o) => o.id))
    script.observation_ids = (script.observation_ids ?? []).filter((id) => queued.has(id))
  } catch (err) {
    console.warn(`[prepare] ${checkin.title}: ${(err as Error).message}`)
    script = fallbackScript(cfg, checkin, err)
  }
  let audioPath: string | null = null
  try {
    audioPath = (await tts.synthesize(script.opener)).path
  } catch (err) {
    console.warn(`[prepare] voice failed: ${(err as Error).message}`)
  }
  const updated = Checkins.setScript(checkin.id, script, audioPath)
  emit('checkin.prepared', { checkin: updated })
  return updated
}
