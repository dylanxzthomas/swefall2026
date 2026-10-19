import { z } from 'zod'

export type PersonalTask = { id: string; title: string; notes: string; dueDate?: string; childId?: string; done: boolean; version: number; createdAt: number; updatedAt: number }
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a valid date.').refine(value => { const parsed = new Date(`${value}T12:00:00Z`); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value }, 'Choose a valid date.')
export const personalTaskSchema = z.object({ title: z.string().trim().min(1, 'Give this task a title.').max(200), notes: z.string().trim().max(2000), dueDate: date.optional(), childId: z.string().max(100).optional() })
export type PersonalTaskInput = z.infer<typeof personalTaskSchema>
export function validateSchedule(text: string, runAt: number, now = Date.now()) {
  if (!text.trim() || text.length > 20000) throw new Error('Describe what you want your assistant to prepare.')
  if (!Number.isFinite(runAt) || runAt <= now || runAt > now + 366 * 24 * 60 * 60 * 1000) throw new Error('Choose a future time within the next year.')
}
