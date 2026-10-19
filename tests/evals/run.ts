import { mkdir, writeFile } from 'node:fs/promises'
import { extractStructured, type ModelUsage } from '../../server/model'
import { extractionSchema, sourceHash } from '../../shared/daymark'
import { preparationPrompt } from '../../shared/preparation'
import { fixtures } from './notices'
import { scoreNotice } from './noticeScore'
import { modelFormat } from '../../server/modelFormat'
if (!process.argv.includes('--live') || !process.env.ANTHROPIC_API_KEY || !process.env.DAYMARK_MODEL) throw new Error('Set the server model credentials and pass --live to evaluate synthetic fixtures. No external calendar or email actions are executed.')
if (fixtures.length !== 60) throw new Error('Expected the fixed 60-fixture release corpus.')
const selectedIds = process.argv.find(arg => arg.startsWith('--cases='))?.slice('--cases='.length).split(',')
if (selectedIds && (!selectedIds.length || selectedIds.some(id => !fixtures.some(f => f.id === id && f.split === 'development')))) throw new Error('Targeted reruns may select existing development fixtures only.')
const selected = selectedIds ? fixtures.filter(f => selectedIds.includes(f.id)) : fixtures
const results = []
for (const f of selected) {
  let usage: ModelUsage | undefined
  let developmentOutput: unknown, error: { category: string; status?: number } | undefined
  let evidenceQuotes = 0, actionsWithEvidence = 0
  const start = performance.now(); const failures: string[] = []
  try {
    const output = await extractStructured(extractionSchema, preparationPrompt, { now: f.now ?? '2027-05-01T12:00:00Z', timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }, { id: 'leo', name: 'Leo' }], caregivers: [{ id: 'alex', name: 'Alex', childIds: ['maya', 'leo'] }], confirmedFacts: [], existingEvents: [], sourceFiles: [], source: f.text }, [], value => { usage = value })
    // Keep only development failures inspectable; never use holdout outputs to tune prompts.
    if (f.split === 'development') developmentOutput = output
    evidenceQuotes = output.actions.reduce((sum, action) => sum + Object.keys(action.evidence).length, 0)
    actionsWithEvidence = output.actions.filter(action => Object.keys(action.evidence).length).length
    failures.push(...scoreNotice(f, output))
  } catch (cause) {
    failures.push('provider_or_schema_failure')
    const status = cause && typeof cause === 'object' && 'status' in cause && typeof cause.status === 'number' && cause.status >= 400 && cause.status < 600 ? cause.status : undefined
    error = { category: status ? 'provider_request' : cause instanceof Error && /Zod|Validation|Parse/.test(cause.name) ? 'model_output' : 'provider_unavailable', ...(status ? { status } : {}) }
  }
  results.push({ usage, id: f.id, split: f.split, pass: !failures.length, failures, evidenceQuotes, actionsWithEvidence, elapsedMs: Math.round(performance.now() - start), ...(error ? { error } : {}), ...(failures.length && developmentOutput ? { developmentOutput } : {}) })
  console.log(`${f.id}: ${failures.length ? 'FAIL' : 'PASS'}`)
}
await mkdir('test-results', { recursive: true })
const totals = (rows: typeof results) => {
  const times = rows.map(row => row.elapsedMs).sort((a, b) => a - b)
  return { cases: rows.length, passed: rows.filter(row => row.pass).length, elapsedMs: times.reduce((a, b) => a + b, 0), medianMs: times.length ? times[Math.floor(times.length / 2)] : 0, p95Ms: times.length ? times[Math.ceil(times.length * 0.95) - 1] : 0, usageRecorded: rows.filter(row => row.usage).length, inputTokens: rows.reduce((sum, row) => sum + (row.usage?.inputTokens ?? 0), 0), outputTokens: rows.reduce((sum, row) => sum + (row.usage?.outputTokens ?? 0), 0) }
}
const summary = { total: totals(results), development: totals(results.filter(row => row.split === 'development')), holdout: totals(results.filter(row => row.split === 'holdout')) }
await writeFile(`test-results/model-evaluation${selectedIds ? '-development' : ''}.json`, JSON.stringify({ model: process.env.DAYMARK_MODEL, evaluatedAt: new Date().toISOString(), synthetic: true, promptHash: sourceHash(preparationPrompt), schemaHash: sourceHash(JSON.stringify(modelFormat(extractionSchema).schema)), corpusHash: sourceHash(JSON.stringify(fixtures)), scope: selectedIds ? 'selected_development' : 'full_corpus', checks: ['expected_fields', 'required_artifact', 'clarification', 'internal_ids', 'unsupported_actions', 'nonempty_exact_source_evidence'], summary, results }, null, 2))
console.log(JSON.stringify(summary))
if (results.some(r => !r.pass)) process.exitCode = 1
