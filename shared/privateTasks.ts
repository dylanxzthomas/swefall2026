import { z } from 'zod'
import { sourceHash } from './daymark.js'
export const privateTaskInputSchema = z.object({ title: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(10000) }).strict()
export type PrivateTaskInput = z.infer<typeof privateTaskInputSchema>
export type PrivateTask = PrivateTaskInput & { id: string; version: number; done: boolean; createdAt: number; updatedAt: number }
/** A private saved task retains only the parent's reviewed text, never connector context. */
export function privateTaskKeepHash(input: PrivateTaskInput, done: boolean) { return sourceHash(JSON.stringify([privateTaskInputSchema.parse(input), done])) }
