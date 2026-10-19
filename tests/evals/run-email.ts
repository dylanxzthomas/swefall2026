import { mkdir, writeFile } from 'node:fs/promises'
import { extractStructured, type ModelUsage } from '../../server/model.js'
import { emailPreparationSchema, emailTriagePrompt } from '../../shared/emailTriage.js'
import { preparationPrompt } from '../../shared/preparation.js'
import { emailFixtures, emailEvaluationInput, gradeEmail } from './emailTriage.js'
const live = process.argv.includes('--live'), check = process.argv.includes('--check')
if (live === check) throw new Error('Choose --check for synthetic references or --live for an explicitly configured model.')
if (live && (!process.env.ANTHROPIC_API_KEY || !process.env.DAYMARK_MODEL)) throw new Error('Configure server model credentials first. No model call was made.')
const results = []
for (const fixture of emailFixtures) {
  let output: unknown, usage: ModelUsage | undefined, failures: string[]
  try { output = check ? fixture.reference : await extractStructured(emailPreparationSchema, preparationPrompt + emailTriagePrompt, emailEvaluationInput(fixture), [], value => { usage = value }); failures = gradeEmail(fixture, output) }
  catch { failures = ['provider_or_schema_failure'] }
  results.push({ id: fixture.id, split: fixture.split, output, failures, usage })
  console.log(`${fixture.id}: ${failures.length ? 'FLAG' : check ? 'REFERENCE CHECKED' : 'AUTOMATED CHECKS PASSED'}`)
}
if (live) { await mkdir('test-results', { recursive: true }); await writeFile('test-results/email-evaluation.json', JSON.stringify({ model: process.env.DAYMARK_MODEL, syntheticInputs: true, liveModel: true, evaluatedAt: new Date().toISOString(), humanReview: 'pending', results }, null, 2)) }
else console.log('Synthetic references checked only. No mailbox read, model call or external action. Live relevance quality remains unverified.')
if (results.some(result => result.failures.length)) process.exitCode = 1
