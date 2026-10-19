import { z } from 'zod'

/** A parent's saved preparation instruction, never permission for an external action. */
export const mailRoutineDefinitionSchema = z.object({
  title: z.string().trim().min(1, 'Name this routine.').max(200),
  condition: z.string().trim().min(1, 'Describe which new emails should trigger this routine.').max(1000),
  instruction: z.string().trim().min(1, 'Describe what Sola should prepare.').max(4000),
}).strict()

export type MailRoutineDefinition = z.infer<typeof mailRoutineDefinitionSchema>
export type MailRoutine = {
  id: string
  version: number
  state: 'active' | 'paused' | 'removed'
  definition?: MailRoutineDefinition
  activatedAt?: number
  lastPreparedAt?: number
  issue?: string
  createdAt: number
  updatedAt: number
}
export type MailRoutineOccurrence = {
  id: string
  routineVersion: number
  createdAt: number
  status: 'prepared' | 'superseded' | 'expired'
  summary: string
  runId?: string
}

export const mailRoutineLimits = { perAdult: 10, history: 30 } as const
