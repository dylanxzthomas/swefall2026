import type Anthropic from '@anthropic-ai/sdk'
import type { Config } from '../config.js'
import type { Brain } from '../llm.js'
import type { TTS } from '../voice/tts.js'
import { Checkins, Events, KV, Messages, Tasks } from '../db.js'
import { worldContext } from '../context.js'
import { turnReminder } from '../prompts.js'
import { buildTools } from './tools.js'
import { emit } from '../bus.js'
import type { Checkin, Message, Task } from '../../shared/types.js'

/** The world as it was when the conversation started. Kept fixed so the cached prefix survives every turn. */
export function worldForCheckin(cfg: Config, checkin: Checkin): string {
  const key = `world:${checkin.id}`
  const cached = KV.get(key)
  if (cached) return cached
  const event = checkin.event_id ? Events.get(checkin.event_id) : undefined
  const world = worldContext(cfg, { checkin, event })
  KV.set(key, world)
  return world
}

export interface TurnResult {
  message: Message
  audioUrl: string | null
  task: Task | null
}

/** One live turn: the user said something, the assistant answers, possibly doing things on the way. */
export async function respond(cfg: Config, brain: Brain, tts: TTS, checkin: Checkin, userText: string, via: 'voice' | 'text'): Promise<TurnResult> {
  const userMsg = Messages.add(checkin.id, 'user', userText.trim(), null, { via })
  emit('message', { checkinId: checkin.id, message: userMsg })

  const world = worldForCheckin(cfg, checkin)
  const history = Messages.forCheckin(checkin.id)
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: `<world>\n${world}\n</world>`, cache_control: { type: 'ephemeral' } },
        {
          type: 'text',
          text: `<conversation kind="${checkin.kind}" title="${checkin.title.replace(/"/g, "'")}">This conversation is starting. ${checkin.script ? 'Your prepared opening line is your first message.' : `${cfg.user.name} opened it by speaking first; there is no opener.`}</conversation>`,
        },
      ],
    },
  ]
  for (const m of history) messages.push({ role: m.role, content: m.text })
  messages.push({ role: 'system', content: turnReminder(cfg, checkin) })

  const steps: import('../../shared/types.js').TaskStep[] = []
  const tools = buildTools({ cfg, checkinId: checkin.id, steps })

  emit('assistant.thinking', { checkinId: checkin.id, on: true })
  let text: string
  try {
    const out = await brain.say({ messages, tools, effort: 'medium', purpose: `converse:${checkin.kind}`, allowOverBudget: true })
    text = out.text || 'Say that again?'
  } catch (err) {
    console.warn(`[converse] ${(err as Error).message}`)
    text = (err as Error).message.includes('budget')
      ? "I'm past today's budget, so I'll stop here. We can pick this up tomorrow."
      : "I lost the thread for a second. Say that again?"
  } finally {
    emit('assistant.thinking', { checkinId: checkin.id, on: false })
  }

  let task: Task | null = null
  if (steps.length) {
    task = Tasks.create({ checkin_id: checkin.id, request: userText.trim().slice(0, 200) })
    task = Tasks.finish(task.id, 'done', steps, text)
    emit('task', { task })
  }

  let audioPath: string | null = null
  try {
    audioPath = (await tts.synthesize(text)).path
  } catch (err) {
    console.warn(`[converse] voice failed: ${(err as Error).message}`)
  }
  const message = Messages.add(checkin.id, 'assistant', text, audioPath)
  emit('message', { checkinId: checkin.id, message })
  Checkins.get(checkin.id)
  return { message, audioUrl: audioPath ? `/audio/${audioPath.split('/').pop()}` : null, task }
}
