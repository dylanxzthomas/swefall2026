import { expect, it } from 'vitest'
import { emailWatchSchema, exactSender, watchQuery } from './emailWatches.js'
it('normalizes exact addresses and refuses inbox-wide query syntax', () => {
  const d = { title: 'School updates', senders: ['SCHOOL@example.test', 'school@example.test'], instruction: 'Find dates needing review.' }
  expect(emailWatchSchema.parse(d).senders).toEqual(['school@example.test'])
  for (const address of ['*', '*@example.test', 'school@example.test OR from:anyone', 'from:school@example.test', 'school@example.test}']) expect(emailWatchSchema.safeParse({ ...d, senders: [address] }).success).toBe(false)
  expect(watchQuery(['school@example.test'], 1000, 10000)).toBe('{from:school@example.test} after:1 before:10 -in:spam -in:trash -in:sent -in:drafts')
  expect(exactSender('Synthetic School <SCHOOL@example.test>')).toBe('school@example.test')
  expect(exactSender('School <school@example.test>, Other <other@example.test>')).toBeNull()
})
