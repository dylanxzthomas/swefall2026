import Anthropic from '@anthropic-ai/sdk'
import type { z } from 'zod'
import { modelFormat } from './modelFormat.js'
import { modelMessages, type ConversationExchange } from './modelMessages.js'
/** Shared provider boundary. Cloud preparation must not import the legacy SQLite runtime. */
export type ModelUsage = { model: string; inputTokens: number; outputTokens: number; elapsedMs: number }
export type ModelBudget = { maxTokens: number; timeoutMs: number }
export const discussionBudget: ModelBudget = { maxTokens: 1000, timeoutMs: 45000 }
export const workingMemoryBudget: ModelBudget = { maxTokens: 1500, timeoutMs: 60000 }
export async function extractStructured<S extends z.ZodType>(schema: S, system: string, input: unknown, attachments: Anthropic.ContentBlockParam[] = [], recordUsage?: (usage: ModelUsage) => void, history?: readonly ConversationExchange[], budget: ModelBudget = { maxTokens: 6000, timeoutMs: 110000 }) {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.DAYMARK_MODEL) throw new Error('Model connection is not configured.')
  if (!Number.isInteger(budget.maxTokens) || budget.maxTokens < 500 || budget.maxTokens > 6000 || !Number.isInteger(budget.timeoutMs) || budget.timeoutMs < 10000 || budget.timeoutMs > 110000) throw new Error('Model budget is outside its supported limits.')
  const client = new Anthropic({ timeout: budget.timeoutMs, maxRetries: 0 }), started = performance.now()
  const model = process.env.DAYMARK_MODEL
  // Explicit pilot setting: avoid Sonnet 5.5's default high effort for bounded
  // email preparation. Other models keep their supported provider defaults.
  const response = await client.messages.parse({ model, max_tokens: budget.maxTokens, system,
    messages: modelMessages(input, attachments, history), output_config: { format: modelFormat(schema), ...(model === 'claude-sonnet-5-5' ? { effort: 'medium' as const } : {}) } })
  if (!response.parsed_output) throw new Error('No validated preparation result.')
  recordUsage?.({ model: response.model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, elapsedMs: Math.round(performance.now() - started) })
  return schema.parse(response.parsed_output)
}
