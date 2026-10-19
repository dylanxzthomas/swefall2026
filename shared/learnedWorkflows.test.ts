import { expect, it } from 'vitest'
import { validateCuration, workflowCurationModelSchema } from './learnedWorkflows.js'
const candidate = { kind: 'fact', title: 'School', reason: 'Useful school context.', quote: 'Maya goes to Oak School.', value: { kind: 'school', childId: 'maya', school: 'Oak School', className: '' } }
it('accepts model-selected typed facts grounded in a literal parent excerpt', () => expect(validateCuration({ candidates: [candidate] }, candidate.quote).candidates).toHaveLength(1))
it('allows no suggestion for one-off or unclear requests', () => expect(validateCuration({ candidates: [] }, 'Hi').candidates).toEqual([]))
it('rejects unsupported facts, tools, invented evidence and duplicate candidates', () => {
  expect(() => validateCuration({ candidates: [{ ...candidate, quote: 'Invented' }] }, candidate.quote)).toThrow('exact')
  expect(() => validateCuration({ candidates: [candidate, candidate] }, candidate.quote)).toThrow('duplicate')
  expect(() => validateCuration({ candidates: [{ ...candidate, tool: 'send_email' }] }, candidate.quote)).toThrow()
  expect(() => validateCuration({ candidates: [{ ...candidate, value: { kind: 'password', value: 'synthetic' } }] }, candidate.quote)).toThrow()
})
it('revalidates kind/value correspondence after the compact provider format', () => {
  const wrongKind = { ...candidate, kind: 'mail_routine' }
  expect(workflowCurationModelSchema.parse({ candidates: [wrongKind] }).candidates).toHaveLength(1)
  expect(() => validateCuration({ candidates: [wrongKind] }, candidate.quote)).toThrow()
})
