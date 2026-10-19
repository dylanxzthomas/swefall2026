import { z } from 'zod'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { personalTaskSchema, type PersonalTaskInput } from './tasks.js'

/** Model output is a suggestion only. Keep this schema compatible with structured output. */
export const emailTaskProposalSchema = z.object({
  title: z.string().min(1).max(200),
  notes: z.string().max(2000),
  dueDate: z.string().nullable(),
  childId: z.string().nullable(),
  evidence: z.array(z.string().max(240)).max(3),
  dateEvidence: z.string().max(240).nullable(),
}).strict()

export type EmailTaskProposal = z.infer<typeof emailTaskProposalSchema>
export type EmailTaskSuggestion = {
  id: string
  jobId: string
  sourceRevision: number
  version: number
  status: 'proposed' | 'saved' | 'dismissed'
  input: PersonalTaskInput
  evidence: string[]
  issue?: string
  personalTaskId?: string
  canSave: boolean
}

/** Use the recorded email body, excluding intake instructions and generated metadata. */
export function groundedEmailTask(proposal: EmailTaskProposal, body: string, children: { id: string }[]): { input: PersonalTaskInput; evidence: string[]; issue?: string } | null {
  const parsed = emailTaskProposalSchema.safeParse(proposal)
  if (!parsed.success || !parsed.data.title.trim()) return null
  const value = parsed.data
  const exactQuote = (quote: string | null): quote is string => Boolean(quote?.trim() && body.includes(quote))
  const evidence = [...new Set(value.evidence.filter(exactQuote))]
  if (!evidence.length) return null

  const input: PersonalTaskInput = { title: value.title.trim(), notes: value.notes.trim() }
  const issues: string[] = []
  if (value.dueDate !== null) {
    const date = personalTaskSchema.shape.dueDate.safeParse(value.dueDate)
    if (date.success && exactQuote(value.dateEvidence)) input.dueDate = date.data
    else issues.push('Check the deadline in the original email and choose a date; the suggested date could not be verified.')
  }
  if (value.childId !== null) {
    if (personalTaskSchema.shape.childId.safeParse(value.childId).success && children.some(child => child.id === value.childId)) input.childId = value.childId
    else issues.push('Choose a child if needed; the suggested child does not match this household.')
  }
  // These checks establish source traceability, not semantic correctness or permission
  // to do the work. An adult still reviews/edits the suggestion before saving a task.
  return { input, evidence, ...(issues.length ? { issue: issues.join(' ') } : {}) }
}

/** Scope this key to the owning adult and Gmail thread; it is not a global task identity. */
export function emailTaskSemanticKey(input: PersonalTaskInput): string {
  const text = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
  const canonical = JSON.stringify(['email-task-v1', text(input.title), text(input.notes), input.dueDate ?? null, input.childId ?? null])
  return bytesToHex(sha256(new TextEncoder().encode(canonical)))
}
