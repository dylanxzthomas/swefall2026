import { z } from 'zod'
import { itemSchema, profileSchema, type HouseholdState, type ItemInput, type Capture } from '../../../shared/household.js'
import { guidedItems } from '../../../shared/guided.js'

export interface Persistence { read(): Promise<string | null>; write(value: string): Promise<void> }
export const initialHousehold = (): HouseholdState => ({ mode: 'guided', profile: { name: 'Our home', members: [{ id: 'parent', name: 'Me', role: 'adult' }], notes: '' }, items: [], captures: [] })

// One durable write per action. Queue read-modify-write operations to avoid lost updates.
export function createLocalStore(storage: Persistence) {
  let queue: Promise<unknown> = Promise.resolve()
  const request = <T>(path = '', method = 'GET', body?: unknown): Promise<T> => {
    const operation = queue.then(async () => {
      const raw = await storage.read()
      const state: HouseholdState = raw ? JSON.parse(raw) : initialHousehold()
      state.mode = 'guided'
      if (method === 'GET' && path === '') return state as T
      let result: unknown = { ok: true }
      const validate = (item: ItemInput) => {
        if (item.owner && !state.profile.members.some(m => m.id === item.owner && m.role === 'adult')) throw new Error('Choose an adult from your household')
        if (item.person && !state.profile.members.some(m => m.id === item.person)) throw new Error('Choose a family member')
      }
      const makeItem = (item: ItemInput, sourceId: string | null = null) => ({ ...item, id: crypto.randomUUID(), done: false, sourceId, createdAt: new Date().toISOString() })
      if (path === '/profile' && method === 'PUT') {
        const profile = profileSchema.parse(body)
        if (!profile.members.some(m => m.role === 'adult')) throw new Error('Add at least one adult')
        state.profile = profile
        for (const item of state.items) {
          if (!profile.members.some(m => m.id === item.owner && m.role === 'adult')) item.owner = null
          if (!profile.members.some(m => m.id === item.person)) item.person = null
        }
      } else if (path === '/items' && method === 'POST') {
        const input = itemSchema.parse(body); validate(input)
        const item = makeItem(input); state.items.push(item); result = item
      } else if (/^\/items\/[^/]+$/.test(path)) {
        const id = path.split('/')[2], item = state.items.find(i => i.id === id)
        if (!item) throw new Error('Item not found')
        if (method === 'DELETE') state.items = state.items.filter(i => i.id !== id)
        else if (method === 'PUT') {
          const input = itemSchema.parse(body); validate(input)
          const { done } = z.object({ done: z.boolean() }).parse(body)
          Object.assign(item, input, { done }); result = item
        } else throw new Error('Unsupported action')
      } else if (path === '/capture' && method === 'POST') {
        const { text } = z.object({ text: z.string().trim().min(1).max(12000) }).parse(body)
        const capture: Capture = { id: crypto.randomUUID(), text, items: guidedItems(text), questions: [], mode: 'guided', status: 'pending', createdAt: new Date().toISOString() }
        state.captures.push(capture); result = capture
      } else if (/^\/captures\/[^/]+\/(approve|dismiss)$/.test(path) && method === 'POST') {
        const [, , id, action] = path.split('/'), capture = state.captures.find(c => c.id === id)
        if (!capture) throw new Error('Update not found')
        if (action === 'approve' && capture.status === 'approved') return result as T
        if (capture.status !== 'pending') throw new Error('This update is already closed')
        if (action === 'dismiss') capture.status = 'dismissed'
        else {
          const { items } = z.object({ items: z.array(itemSchema).min(1).max(30) }).parse(body)
          items.forEach(validate)
          state.items.push(...items.map(i => makeItem(i, id)))
          capture.items = items; capture.status = 'approved'
        }
      } else throw new Error('Unsupported action')
      await storage.write(JSON.stringify(state))
      return result as T
    })
    queue = operation.catch(() => undefined)
    return operation
  }
  return { request }
}
