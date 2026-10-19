// @vitest-environment node
import { expect, it } from 'vitest'
import { modelFormat } from '../server/modelFormat.js'
import { emailPreparationSchema } from './emailTriage.js'
import { extractionSchema, payloadHash } from './daymark.js'
import { event } from '../tests/fixtures/calendar.js'
import { privateConversationSchema } from './conversation.js'
import { z } from 'zod'
import { revisionSchema } from './preparation.js'
import { validateCuration, workflowCurationModelSchema } from './learnedWorkflows.js'

it('provides a supported private reply grammar with no action or permission fields', () => {
  const format = modelFormat(privateConversationSchema)
  expect(format.parse('{"clarification":"The museum form is due October 12."}')).toEqual({ clarification: 'The museum form is due October 12.' })
  expect(() => format.parse('{"clarification":"Done","actions":[{"kind":"email"}]}')).toThrow()
  expect(() => format.parse('{"clarification":""}')).toThrow()
})

it('reduces nullable-string grammar branches and restores only nullable fields', () => {
  const format = modelFormat(emailPreparationSchema)
  const text = JSON.stringify(format.schema)
  expect(text).not.toContain('"type":["string","null"]')
  expect(text).toContain('the application restores null')
  const wireEvent = { ...event, childId: '', startTime: '', targetId: '', notes: '', date: '' }
  const parsed = format.parse(JSON.stringify({ actions: [wireEvent], clarification: '', triage: { decision: 'actionable', reason: 'Synthetic test', evidence: ['Synthetic'] }, tasks: [{ title: 'Return form', notes: '', dueDate: '', childId: '', evidence: ['Synthetic'], dateEvidence: '' }] }))
  expect(parsed.actions[0]).toMatchObject({ childId: null, startTime: null, targetId: null, notes: '', date: '' })
  expect(parsed.tasks[0]).toMatchObject({ dueDate: null, childId: null, dateEvidence: null })
})

it('preserves existing payload hashes and omitted optional changes', () => {
  const format = modelFormat(extractionSchema)
  const parsed = format.parse(JSON.stringify({ actions: [event], clarification: '' }))
  expect(payloadHash(parsed.actions[0])).toBe(payloadHash(event))
  const pickup = { kind: 'pickup', childId: '', caregiverId: '', date: '', time: '', timezone: 'UTC', location: '', deadline: '', message: '', evidence: {} }
  const result = format.parse(JSON.stringify({ actions: [pickup], clarification: '' }))
  expect(result.actions[0]).not.toHaveProperty('calendarUpdate')
  expect(result.actions[0]).not.toHaveProperty('followUpAt')
  expect(result.actions[0]).toMatchObject({ childId: null, caregiverId: null, time: null })
})

it('restores referenced nested calendar fields without losing the original bounds', () => {
  const format = modelFormat(extractionSchema)
  const pickup = { kind: 'pickup', childId: '', caregiverId: '', date: '', time: '', timezone: 'UTC', location: '', deadline: '', message: '', evidence: {}, calendarUpdate: { ...event, childId: '', targetId: '' } }
  expect(format.parse(JSON.stringify({ actions: [pickup], clarification: '' })).actions[0]).toMatchObject({ calendarUpdate: { childId: null, targetId: null } })
  expect(() => format.parse(JSON.stringify({ actions: [{ ...event, title: 'x'.repeat(301) }], clarification: '' }))).toThrow()
  expect(() => format.parse(JSON.stringify({ actions: [{ ...event, childId: 42 }], clarification: '' }))).toThrow()
  expect(() => format.parse(JSON.stringify({ actions: [{ ...event, kind: 'purchase' }], clarification: '' }))).toThrow()
})

it('exposes dynamic evidence as entries and restores referenced maps without changing reviewed payload hashes', () => {
  const format = modelFormat(extractionSchema)
  const evidenceSchemas: any[] = []
  const visit = (node: any) => { if (!node || typeof node !== 'object') return; if (node.properties?.evidence) evidenceSchemas.push(node.properties.evidence); Object.values(node).forEach(visit) }
  visit(format.schema)
  expect(evidenceSchemas).toHaveLength(3)
  for (const evidence of evidenceSchemas) expect(evidence).toMatchObject({ type: 'array', items: { type: 'object', required: ['key', 'value'], additionalProperties: false, properties: { key: { type: 'string' }, value: { type: 'string' } } } })
  const source = { ...event, evidence: { date: 'October 9, 2026', startTime: '8:30 AM' } }
  const encoded = { ...source, evidence: Object.entries(source.evidence).map(([key, value]) => ({ key, value })) }
  const restored = format.parse(JSON.stringify({ actions: [encoded], clarification: '' })).actions[0]
  expect(restored).toEqual(source)
  expect(payloadHash(restored)).toBe(payloadHash(source))
  expect(modelFormat(revisionSchema).parse(JSON.stringify({ payload: encoded, clarification: '' })).payload).toEqual(source)
  const pickup = { kind: 'pickup', childId: '', caregiverId: '', date: '', time: '', timezone: 'UTC', location: '', deadline: '', message: '', evidence: [{ key: 'time', value: '8:30 AM' }], calendarUpdate: encoded }
  expect(format.parse(JSON.stringify({ actions: [pickup], clarification: '' })).actions[0]).toMatchObject({ evidence: { time: '8:30 AM' }, calendarUpdate: source })
})

it('retains original string-key, quote-length and record refinements after decoding', () => {
  const format = modelFormat(z.object({ evidence: z.record(z.string().max(80), z.string().max(2000)).refine(value => Object.keys(value).length <= 20) }))
  expect(format.parse(JSON.stringify({ evidence: [{ key: 'field', value: 'exact quote' }] }))).toEqual({ evidence: { field: 'exact quote' } })
  for (const evidence of [[{ key: 'x'.repeat(81), value: 'quote' }], [{ key: 'field', value: 'x'.repeat(2001) }], Array.from({ length: 21 }, (_, i) => ({ key: `field${i}`, value: 'quote' }))]) expect(() => format.parse(JSON.stringify({ evidence }))).toThrow()
})

it('refuses ambiguous entries, duplicate keys and prototype keys before reconstructing any dictionary', () => {
  const format = modelFormat(z.object({ evidence: z.record(z.string(), z.string()) }))
  for (const evidence of [[{ key: 'date', value: 'first' }, { key: 'date', value: 'second' }], [{ key: 'date', value: 42 }], [{ key: 'date', value: 'quote', extra: 'ignored?' }], [{ key: 'date' }], null, 'quote', ...['__proto__', 'prototype', 'constructor'].map(key => [{ key, value: 'unsafe' }])]) expect(() => format.parse(JSON.stringify({ evidence }))).toThrow()
  expect(() => format.parse('{"evidence":{"__proto__":"unsafe"}}')).toThrow()
  expect(Object.getPrototypeOf(format.parse('{"evidence":[{"key":"hasOwnProperty","value":"quote"}]}').evidence)).toBe(Object.prototype)
  expect(({} as Record<string, unknown>).unsafe).toBeUndefined()
})

it('roundtrips complete and optional curation routine fields without treating optional dates or children as nullable', () => {
  const format = modelFormat(workflowCurationModelSchema)
  const candidate = { kind: 'routine', title: 'Pack school bags', reason: 'The parent requested weekly preparation.', quote: 'Every Sunday I pack school bags.', value: { title: 'Pack school bags', outcome: { kind: 'personal_task', task: { title: 'Pack school bags', notes: '' }, dueAfterDays: 0 }, schedule: { frequency: 'weekly', time: '19:00', timezone: 'UTC', startDate: '2026-10-18', weekdays: [7] } } }
  const parse = (value: unknown) => format.parse(JSON.stringify({ candidates: [value] }))
  const result = parse(candidate)
  expect(result).toEqual({ candidates: [candidate] })
  expect(validateCuration(result, candidate.quote)).toEqual(result)
  const complete = { ...candidate, value: { ...candidate.value, outcome: { ...candidate.value.outcome, task: { ...candidate.value.outcome.task, childId: 'maya' } }, schedule: { ...candidate.value.schedule, endDate: '2026-12-27', exceptDates: ['2026-11-22'] } } }
  expect(parse(complete)).toEqual({ candidates: [complete] })
  for (const endDate of ['', null, '2026-02-30']) expect(() => parse({ ...candidate, value: { ...candidate.value, schedule: { ...candidate.value.schedule, endDate } } })).toThrow()
  for (const childId of ['', null]) expect(() => parse({ ...candidate, value: { ...candidate.value, outcome: { ...candidate.value.outcome, task: { ...candidate.value.outcome.task, childId } } } })).toThrow()
  expect(() => validateCuration(parse({ ...candidate, kind: 'fact' }), candidate.quote)).toThrow()
})
