import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { itemSchema, profileSchema, type Capture, type HouseholdData, type HouseholdItem, type ItemInput } from '../../shared/household.js'

export class HouseholdStore {
  private db: DatabaseSync
  constructor(filename: string) {
    this.db = new DatabaseSync(filename)
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS household (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)')
    const initial: HouseholdData = { profile: { name: 'Our home', members: [{ id: 'parent', name: 'Me', role: 'adult' }], notes: '' }, items: [], captures: [] }
    this.db.prepare('INSERT OR IGNORE INTO household (id,value) VALUES (1,?)').run(JSON.stringify(initial))
  }
  read(): HouseholdData {
    return JSON.parse((this.db.prepare('SELECT value FROM household WHERE id=1').get() as { value: string }).value)
  }
  change<T>(fn: (data: HouseholdData) => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const data = this.read(), result = fn(data)
      this.db.prepare('UPDATE household SET value=? WHERE id=1').run(JSON.stringify(data))
      this.db.exec('COMMIT')
      return result
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  validateMember(data: HouseholdData, item: ItemInput) {
    if (item.owner && !data.profile.members.some(m => m.id === item.owner && m.role === 'adult')) throw new Error('Choose an adult from your household')
    if (item.person && !data.profile.members.some(m => m.id === item.person)) throw new Error('Choose a family member')
  }
  saveProfile(input: unknown) {
    const profile = profileSchema.parse(input)
    if (!profile.members.some(m => m.role === 'adult')) throw new Error('Add at least one adult')
    this.change(data => {
      data.profile = profile
      for (const item of data.items) {
        if (!profile.members.some(m => m.id === item.owner && m.role === 'adult')) item.owner = null
        if (!profile.members.some(m => m.id === item.person)) item.person = null
      }
    })
  }
  add(input: unknown) {
    const parsed = itemSchema.parse(input)
    return this.change(data => {
      this.validateMember(data, parsed)
      const item: HouseholdItem = { ...parsed, id: randomUUID(), done: false, sourceId: null, createdAt: new Date().toISOString() }
      data.items.push(item)
      return item
    })
  }
  update(id: string, input: unknown, done: boolean) {
    const parsed = itemSchema.parse(input)
    return this.change(data => {
      const item = data.items.find(i => i.id === id)
      if (!item) throw new Error('Item not found')
      this.validateMember(data, parsed)
      Object.assign(item, parsed, { done })
      return item
    })
  }
  remove(id: string) { this.change(data => { data.items = data.items.filter(i => i.id !== id) }) }
  capture(text: string, items: ItemInput[], questions: string[], mode: Capture['mode']) {
    const capture: Capture = { id: randomUUID(), text, items, questions, mode, status: 'pending', createdAt: new Date().toISOString() }
    this.change(data => { data.captures.push(capture) })
    return capture
  }
  approve(id: string, inputs: unknown[]) {
    const items = inputs.map(i => itemSchema.parse(i))
    return this.change(data => {
      const capture = data.captures.find(c => c.id === id)
      if (!capture) throw new Error('Update not found')
      if (capture.status === 'approved') return // Duplicate submissions cannot duplicate the plan.
      if (capture.status !== 'pending') throw new Error('This update has been dismissed')
      items.forEach(i => this.validateMember(data, i))
      items.forEach(i => data.items.push({ ...i, id: randomUUID(), sourceId: id, done: false, createdAt: new Date().toISOString() }))
      capture.status = 'approved'
      capture.items = items
    })
  }
  dismiss(id: string) { this.change(data => {
    const capture = data.captures.find(c => c.id === id)
    if (!capture || capture.status !== 'pending') throw new Error('Pending update not found')
    capture.status = 'dismissed'
  }) }
  close() { this.db.close() }
}
