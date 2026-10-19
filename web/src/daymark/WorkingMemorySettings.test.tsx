import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import WorkingMemorySettings from './WorkingMemorySettings'

it('explains the private bounded context and offers clearing only for a connected account', () => {
  const state = { workingMemory: { version: 1, excerptCount: 3 } }, client = { resetWorkingMemory: async () => 2 }
  const html = renderToStaticMarkup(<WorkingMemorySettings state={state} client={client} />)
  expect(html).toContain('Clear older working context')
  expect(html).toContain('3 older excerpts')
  expect(html).toContain('confirmed family facts')
  expect(renderToStaticMarkup(<WorkingMemorySettings state={{ ...state, storage: 'device' }} client={client} />)).toBe('')
  expect(renderToStaticMarkup(<WorkingMemorySettings state={state} client={{}} />)).toBe('')
})
