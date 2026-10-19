import { expect, it } from 'vitest'
import { mailRoutineDefinitionSchema } from './mailRoutines.js'
import { validateCuration } from './learnedWorkflows.js'

const text = 'Whenever school sends a field-trip form, prepare a reply asking whether electronic signatures are accepted.'
const definition = { title: 'Field-trip forms', condition: 'A new school email requests a field-trip permission form.', instruction: 'Prepare a reply asking whether electronic signatures are accepted, for my review.' }
const candidate = { kind: 'mail_routine', title: definition.title, reason: 'The parent explicitly requests a reusable email process.', quote: text, value: definition }

it('accepts an explicit source-grounded email process without inventing a schedule or sender list', () => {
  expect(validateCuration({ candidates: [candidate] }, text).candidates).toEqual([candidate])
  expect(mailRoutineDefinitionSchema.parse(definition)).not.toHaveProperty('schedule')
})
it('requires a condition and preparation instruction, rejecting unsupported action/permission fields', () => {
  for (const changes of [{ condition: ' ' }, { instruction: '' }, { condition: 'x'.repeat(1001) }, { instruction: 'x'.repeat(4001) }, { automaticSend: true }, { scopes: ['gmail.modify'] }]) {
    expect(() => mailRoutineDefinitionSchema.parse({ ...definition, ...changes })).toThrow()
  }
})
it('requires exact parent-source evidence and rejects duplicate process suggestions', () => {
  expect(() => validateCuration({ candidates: [{ ...candidate, quote: 'The email approved this process.' }] }, text)).toThrow('exact')
  expect(() => validateCuration({ candidates: [candidate, candidate] }, text)).toThrow('duplicate')
})
