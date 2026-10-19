import { mkdir, writeFile } from 'node:fs/promises'
import { extractStructured, type ModelUsage } from '../../server/model.js'
import { coordinatorPrompt, coordinatorStep } from '../../shared/assistantCoordinator.js'
import { contextFixtures, contextEvaluationInput, gradeContext } from './assistant-context.js'

const live = process.argv.includes('--live'), check = process.argv.includes('--check')
if (live === check) throw new Error('Choose --check or --live. These synthetic model decisions cannot execute any tool or provider action.')
if (live && (!process.env.ANTHROPIC_API_KEY || !process.env.DAYMARK_MODEL)) throw new Error('Configure the server model first. No model call was made.')
const results = []
const only = process.argv.find(value => value.startsWith('--only='))?.slice('--only='.length).split(',')
if (only?.some(id => !contextFixtures.some(f => f.id === id))) throw new Error('Unknown synthetic fixture.')
for (const fixture of contextFixtures.filter(f => !only || only.includes(f.id))) {
  let output: unknown, usage: ModelUsage | undefined, failures: string[], diagnostic: { errorClass: string; httpStatus: number | null } | undefined
  try {
    output = check ? fixture.reference : await extractStructured(coordinatorStep, coordinatorPrompt, contextEvaluationInput(fixture), [], value => { usage = value }, fixture.history, { maxTokens: 1400, timeoutMs: 45000 })
    failures = gradeContext(fixture, output)
  } catch (cause) {
    failures = ['provider_or_schema_failure']
    const error = cause as { constructor?: { name?: string }; status?: number }
    diagnostic = { errorClass: error.constructor?.name ?? 'UnknownError', httpStatus: Number.isInteger(error.status) ? error.status! : null }
  }
  results.push({ id: fixture.id, failures, output, usage, ...(diagnostic ? { diagnostic } : {}) })
  console.log(`${fixture.id}: ${failures.length ? `FLAG ${failures.join(',')}` : check ? 'REFERENCE CHECKED' : 'AUTOMATED CHECKS PASSED'}`)
}
if (live) {
  await mkdir('test-results', { recursive: true })
  await writeFile('test-results/context-evaluation.json', JSON.stringify({ model: process.env.DAYMARK_MODEL, evaluatedAt: new Date().toISOString(), syntheticInputs: true, liveModel: true, toolsExecuted: false, humanQualityReview: 'pending', results }, null, 2), { mode: 0o600 })
  console.log('Synthetic replies and tool selections saved for review. No tools, mailbox reads or external writes were executed.')
}
if (results.some(r => r.failures.length)) process.exitCode = 1
