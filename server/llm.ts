import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import * as z from 'zod/v4'
import type { Config } from './config.js'
import { env } from './config.js'
import { Usage } from './db.js'
import { ymd } from './time.js'
import { persona } from './prompts.js'
import { readProfile } from './profile.js'
import { emit } from './bus.js'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** USD per million tokens. Cache reads are ~10% of input, cache writes ~125%. */
const PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
}

export class BrainUnavailable extends Error {
  constructor() {
    super('No ANTHROPIC_API_KEY, so the brain is running in mock mode.')
  }
}
export class BudgetExhausted extends Error {
  constructor(spent: number, budget: number) {
    super(`Today's budget is spent ($${spent.toFixed(2)} of $${budget.toFixed(2)}).`)
  }
}

type BetaTools = Parameters<Anthropic['beta']['messages']['toolRunner']>[0]['tools']

export interface SayOptions {
  messages: Anthropic.Beta.BetaMessageParam[]
  purpose: string
  effort?: Effort
  tools?: BetaTools
  maxIterations?: number
  /** Live conversation replies may run up to 2x the daily budget so a conversation never dies mid-sentence. */
  allowOverBudget?: boolean
}

export interface StructuredOptions<T> {
  messages: Anthropic.MessageParam[]
  purpose: string
  effort?: Effort
  mock: T
  system?: string
}

function textOf(content: { type: string; text?: string }[]): string {
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim()
}

/** Spoken output should never carry markdown or the em dash, whatever the model does. */
export function forSpeech(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export class Brain {
  readonly client: Anthropic | null
  inFlight = 0

  constructor(private readonly cfg: () => Config) {
    this.client = env.anthropicKey && !env.mockBrain ? new Anthropic({ timeout: 180_000, maxRetries: 2 }) : null
  }

  get available(): boolean {
    return this.client !== null
  }

  get model(): string {
    return this.cfg().assistant.model
  }

  spentToday(): number {
    return Usage.today(ymd(new Date())).cost
  }

  budgetLeft(): number {
    return this.cfg().thinking.dailyBudgetUsd - this.spentToday()
  }

  private guard(multiplier: number): void {
    if (!this.client) throw new BrainUnavailable()
    const budget = this.cfg().thinking.dailyBudgetUsd
    const spent = this.spentToday()
    if (spent >= budget * multiplier) throw new BudgetExhausted(spent, budget)
  }

  /** Persona + profile. Both stable across requests, so the whole prefix caches. */
  private systemBlocks(): Anthropic.TextBlockParam[] {
    const cfg = this.cfg()
    return [
      { type: 'text', text: persona(cfg) },
      {
        type: 'text',
        text: `<about_${cfg.user.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}>\n${readProfile()}\n</about_${cfg.user.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}>`,
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ]
  }

  private record(purpose: string, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): void {
    const p = PRICES[this.model] ?? PRICES['claude-opus-5']
    const cr = usage.cache_read_input_tokens ?? 0
    const cw = usage.cache_creation_input_tokens ?? 0
    const cost = (usage.input_tokens * p.in + cr * p.cacheRead + cw * p.cacheWrite + usage.output_tokens * p.out) / 1e6
    Usage.add({ day: ymd(new Date()), model: this.model, purpose, input: usage.input_tokens, cacheRead: cr, cacheWrite: cw, output: usage.output_tokens, cost })
    emit('usage', { purpose, cost, spentToday: this.spentToday() })
  }

  private track<T>(purpose: string, fn: () => Promise<T>): Promise<T> {
    this.inFlight++
    emit('brain.busy', { inFlight: this.inFlight, purpose })
    return fn().finally(() => {
      this.inFlight--
      emit('brain.busy', { inFlight: this.inFlight, purpose })
    })
  }

  /** A spoken reply, optionally with tools. Uses the beta surface so refusals fall back server-side instead of ending the conversation. */
  async say(opts: SayOptions): Promise<{ text: string; stopReason: string }> {
    if (!this.client) {
      const cfg = this.cfg()
      return {
        text: `[mock] ${cfg.assistant.name} would answer here. Put ANTHROPIC_API_KEY in .env and restart to think for real.`,
        stopReason: 'mock',
      }
    }
    this.guard(opts.allowOverBudget ? 2 : 1)
    const client = this.client
    return this.track(opts.purpose, async () => {
      const base = {
        model: this.model,
        max_tokens: 16000,
        system: this.systemBlocks(),
        thinking: { type: 'adaptive' as const },
        output_config: { effort: opts.effort ?? 'medium' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default' as const,
        messages: opts.messages,
      }
      if (opts.tools && opts.tools.length > 0) {
        const runner = client.beta.messages.toolRunner({ ...base, tools: opts.tools, max_iterations: opts.maxIterations ?? 8 })
        for await (const message of runner) {
          this.record(opts.purpose, message.usage)
          if (message.stop_reason === 'pause_turn') runner.pushMessages({ role: 'assistant', content: message.content })
        }
        const final = await runner.done()
        if (final.stop_reason === 'refusal') return { text: "I'm not going to go there.", stopReason: 'refusal' }
        return { text: forSpeech(textOf(final.content)), stopReason: final.stop_reason ?? 'end_turn' }
      }
      const res = await client.beta.messages.create(base)
      this.record(opts.purpose, res.usage)
      if (res.stop_reason === 'refusal') return { text: "I'm not going to go there.", stopReason: 'refusal' }
      return { text: forSpeech(textOf(res.content)), stopReason: res.stop_reason ?? 'end_turn' }
    })
  }

  /** A typed result for the thinking passes (prepare, reflect, extract). */
  async structured<S extends z.ZodType>(schema: S, opts: StructuredOptions<z.infer<S>>): Promise<z.infer<S> | null> {
    if (!this.client) return opts.mock
    this.guard(1)
    const client = this.client
    return this.track(opts.purpose, async () => {
      const res = await client.messages.parse({
        model: this.model,
        max_tokens: 16000,
        system: opts.system ?? this.systemBlocks(),
        thinking: { type: 'adaptive' },
        output_config: { effort: opts.effort ?? 'high', format: zodOutputFormat(schema) },
        messages: opts.messages,
      })
      this.record(opts.purpose, res.usage)
      if (res.stop_reason === 'refusal') return null
      return (res.parsed_output as z.infer<S> | null) ?? null
    })
  }
}
