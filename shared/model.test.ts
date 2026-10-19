// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
const calls = vi.hoisted(() => ({ parse: vi.fn(), construct: vi.fn() }))
vi.mock('@anthropic-ai/sdk', () => ({ default: class {
  messages = { parse: calls.parse }
  constructor(options: unknown) { calls.construct(options) }
} }))
import { extractStructured, discussionBudget, workingMemoryBudget } from '../server/model.js'

const schema = z.object({ answer: z.string() }).strict()
beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-test-key')
  vi.stubEnv('DAYMARK_MODEL', 'claude-sonnet-5-5')
  calls.parse.mockReset(); calls.construct.mockReset()
  calls.parse.mockResolvedValue({ parsed_output: { answer: 'Synthetic answer' }, model: 'claude-sonnet-5-5', usage: { input_tokens: 12, output_tokens: 8 } })
})
afterEach(() => vi.unstubAllEnvs())
it('uses bounded medium-effort structured preparation without execution tools or retries', async () => {
  const record = vi.fn()
  await expect(extractStructured(schema, 'Synthetic instructions', { text: 'Synthetic email' }, [], record)).resolves.toEqual({ answer: 'Synthetic answer' })
  const request = calls.parse.mock.calls[0][0]
  expect(request).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 6000, output_config: { effort: 'medium', format: { type: 'json_schema' } } })
  expect(request).not.toHaveProperty('tools')
  expect(request).not.toHaveProperty('temperature')
  expect(JSON.stringify(request)).not.toContain('synthetic-test-key')
  expect(calls.construct).toHaveBeenCalledWith({ timeout: 110_000, maxRetries: 0 })
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 12, outputTokens: 8 }))
})
it('does not send unsupported effort settings to a different model', async () => {
  vi.stubEnv('DAYMARK_MODEL', 'claude-haiku-4-5-20251001')
  await extractStructured(schema, 'Synthetic instructions', {})
  expect(calls.parse.mock.calls[0][0].output_config).not.toHaveProperty('effort')
})
it('refuses missing credentials and unvalidated responses', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  await expect(extractStructured(schema, 'Synthetic instructions', {})).rejects.toThrow('not configured')
  expect(calls.construct).not.toHaveBeenCalled()
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-test-key')
  calls.parse.mockResolvedValue({ parsed_output: null })
  await expect(extractStructured(schema, 'Synthetic instructions', {})).rejects.toThrow('No validated')
  calls.parse.mockResolvedValue({ parsed_output: { answer: 12 } })
  await expect(extractStructured(schema, 'Synthetic instructions', {})).rejects.toThrow()
})
it.each([discussionBudget, workingMemoryBudget])('uses the bounded operation budget without enabling retries', async budget => {
  await extractStructured(schema, 'Synthetic instructions', {}, [], undefined, undefined, budget)
  expect(calls.parse.mock.calls[0][0].max_tokens).toBe(budget.maxTokens)
  expect(calls.construct).toHaveBeenCalledWith({ timeout: budget.timeoutMs, maxRetries: 0 })
})
it.each([{ maxTokens: 100000, timeoutMs: 45000 }, { maxTokens: 1000, timeoutMs: 999999 }, { maxTokens: 1000.5, timeoutMs: 45000 }])('refuses unsafe model budgets before provider access', async budget => {
  await expect(extractStructured(schema, 'Synthetic instructions', {}, [], undefined, undefined, budget)).rejects.toThrow('outside')
  expect(calls.construct).not.toHaveBeenCalled()
})
