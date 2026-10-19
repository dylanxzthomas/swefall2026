import { expect, it } from 'vitest'
import { z } from 'zod'
import { emailTaskProposalSchema, emailTaskSemanticKey, groundedEmailTask, type EmailTaskProposal } from './emailTasks.js'

const body = 'Please return the signed field trip form by October 12, 2026. Bring a packed lunch. Thank you!'
const children = [{ id: 'child-maya' }]
const proposal: EmailTaskProposal = {
  title: 'Return the field trip form', notes: 'Sign the form before returning it.',
  dueDate: '2026-10-12', childId: 'child-maya',
  evidence: ['Please return the signed field trip form by October 12, 2026.'], dateEvidence: 'by October 12, 2026',
}

it('prepares a reviewable task from exact body evidence without setting completion or save authority', () => {
  const result = groundedEmailTask(proposal, body, children)
  expect(result).toEqual({ input: { title: proposal.title, notes: proposal.notes, dueDate: '2026-10-12', childId: 'child-maya' }, evidence: proposal.evidence })
  expect(result?.input).not.toHaveProperty('done')
  expect(result).not.toHaveProperty('canSave')
  expect(proposal).not.toHaveProperty('personalTaskId')
})

it('drops suggestions with fabricated, case-changed, metadata-only or blank evidence', () => {
  for (const evidence of [[], ['Return this already signed form.'], ['please return'], ['Subject: Field trip form'], [''], ['  ']]) {
    expect(groundedEmailTask({ ...proposal, evidence }, body, children), JSON.stringify(evidence)).toBeNull()
  }
  expect(groundedEmailTask(proposal, '', children)).toBeNull()
})

it('keeps only exact evidence, removes duplicates and preserves original excerpts', () => {
  const quote = 'Bring a packed lunch.'
  const result = groundedEmailTask({ ...proposal, evidence: [quote, 'This has been paid.', quote] }, body, children)
  expect(result?.evidence).toEqual([quote])
})

it('omits dates without exact nonempty date evidence while retaining the task for review', () => {
  for (const dateEvidence of [null, '', ' ', 'October 13, 2026', 'Subject: Due October 12']) {
    const result = groundedEmailTask({ ...proposal, dateEvidence }, body, children)
    expect(result?.input).not.toHaveProperty('dueDate')
    expect(result?.issue).toContain('Check the deadline')
    expect(result?.evidence).toEqual(proposal.evidence)
  }
})

it('rejects impossible or non-ISO calendar dates even when a quoted deadline exists', () => {
  for (const dueDate of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-10-00', '2026-1-2', '10/12/2026', '2026-10-12T00:00:00Z', '']) {
    const result = groundedEmailTask({ ...proposal, dueDate }, body, children)
    expect(result?.input, dueDate).not.toHaveProperty('dueDate')
    expect(result?.issue).toContain('Check the deadline')
  }
  expect(groundedEmailTask({ ...proposal, dueDate: '2028-02-29', dateEvidence: 'by February 29, 2028', evidence: ['by February 29, 2028'] }, 'Return the form by February 29, 2028.', children)?.input.dueDate).toBe('2028-02-29')
})

it('omits another household’s child and reports both date and child corrections', () => {
  const result = groundedEmailTask({ ...proposal, childId: 'other-household-child', dateEvidence: null }, body, children)
  expect(result?.input).toEqual({ title: proposal.title, notes: proposal.notes })
  expect(result?.issue).toContain('Check the deadline')
  expect(result?.issue).toContain('Choose a child')
})

it('allows undated household tasks and trims editable copy without inventing missing details', () => {
  expect(groundedEmailTask({ ...proposal, title: '  Pack lunch  ', notes: '  A packed lunch.  ', dueDate: null, childId: null, dateEvidence: null }, body, children)).toEqual({
    input: { title: 'Pack lunch', notes: 'A packed lunch.' }, evidence: proposal.evidence,
  })
  expect(groundedEmailTask({ ...proposal, title: ' \n ' }, body, children)).toBeNull()
})

it('bounds model content and rejects model-supplied execution/completion fields', () => {
  for (const value of [
    { ...proposal, title: 'x'.repeat(201) }, { ...proposal, notes: 'x'.repeat(2001) },
    { ...proposal, evidence: Array(4).fill('Bring a packed lunch.') },
    { ...proposal, evidence: ['x'.repeat(241)] }, { ...proposal, dateEvidence: 'x'.repeat(241) },
    { ...proposal, done: true }, { ...proposal, approved: true },
  ]) {
    expect(emailTaskProposalSchema.safeParse(value).success).toBe(false)
    expect(groundedEmailTask(value, body, children)).toBeNull()
  }
  expect(() => z.toJSONSchema(emailTaskProposalSchema)).not.toThrow()
})

it('uses case and spacing normalized task content for same-thread duplicate detection', () => {
  const input = { title: 'Return the form', notes: 'Sign before returning.', dueDate: '2026-10-12', childId: 'child-maya' }
  const key = emailTaskSemanticKey(input)
  expect(emailTaskSemanticKey({ ...input, title: ' RETURN  THE\nFORM ', notes: '\tSign BEFORE returning.\n' })).toBe(key)
  for (const changed of [
    { ...input, title: 'Pack lunch' }, { ...input, notes: 'New consent required.' },
    { ...input, dueDate: '2026-10-13' }, { ...input, childId: 'child-lily' },
    { ...input, dueDate: undefined }, { ...input, childId: undefined },
  ]) expect(emailTaskSemanticKey(changed)).not.toBe(key)
})
