import type { ItemInput } from './household.js'

// Guided mode is deliberately literal: it never invents dates from free-form prose.
export function guidedItems(text: string): ItemInput[] {
  return text.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 30).map(line => {
    const match = /^(event|task|buy|shopping):\s*(.+)$/i.exec(line)
    const kind = match?.[1].toLowerCase()
    return {
      kind: kind === 'event' ? 'event' : kind === 'buy' || kind === 'shopping' ? 'shopping' : 'task',
      title: (match?.[2] ?? line).slice(0, 200), date: null, time: null, duration: 30,
      owner: null, person: null, notes: '',
    }
  })
}
