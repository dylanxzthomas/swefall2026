import { mkdir, writeFile } from 'node:fs/promises'
import { extractStructured, type ModelUsage } from '../../server/model.js'
import { conversationPrompt, conversationSchema } from '../../shared/conversation.js'
import { conversationFixtures, gradeConversation } from './conversation.js'

const live = process.argv.includes('--live'), check = process.argv.includes('--check')
if (live === check) throw new Error('Choose --check to validate the synthetic evaluator, or --live to evaluate an explicitly configured model. No tools or external writes are available.')
if (live && (!process.env.ANTHROPIC_API_KEY || !process.env.DAYMARK_MODEL)) throw new Error('Live conversation evaluation needs server-only ANTHROPIC_API_KEY and an explicitly selected DAYMARK_MODEL. No model call was made.')
const results = []
for (const fixture of conversationFixtures) {
  let output: unknown, usage: ModelUsage | undefined, failures: string[]
  const started = performance.now()
  try {
    output = check ? fixture.reference : await extractStructured(conversationSchema, conversationPrompt, fixture.input, [], value => { usage = value }, (fixture.input.assistant as { history: { request: string; response: string }[] }).history)
    failures = gradeConversation(fixture, output)
  } catch { failures = ['provider_or_schema_failure'] }
  results.push({ id: fixture.id, split: fixture.split, failures, output, usage, elapsedMs: Math.round(performance.now() - started), manualReview: fixture.review })
  console.log(`${fixture.id}: ${failures.length ? 'FLAG' : check ? 'REFERENCE CHECKED' : 'AUTOMATED CHECKS PASSED'}`)
}
if (live) {
  await mkdir('test-results', { recursive: true })
  await writeFile('test-results/conversation-evaluation.json', JSON.stringify({ model: process.env.DAYMARK_MODEL, evaluatedAt: new Date().toISOString(), syntheticInputs: true, liveModel: true, humanToneReview: 'pending', results }, null, 2))
  console.log('Responses saved for human review. Automated checks do not establish tone quality or release readiness.')
} else console.log('Checked synthetic reference answers only. No model evaluated and no live results written.')
if (results.some(result => result.failures.length)) process.exitCode = 1
