import { z } from 'zod'

export const gmailReadScope = 'https://www.googleapis.com/auth/gmail.readonly'
export const watchIntervalMs = 15 * 60_000
export const watchBatchSize = 5
// Deliberately exclude search syntax, display names and domain-wide wildcards.
const sender = z.string().trim().toLowerCase().email().max(254).regex(/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/)
export const emailWatchSchema = z.object({
  title: z.string().trim().min(1).max(100),
  senders: z.array(sender).min(1).max(5).transform(v => [...new Set(v)].sort()),
  instruction: z.string().trim().min(1).max(1000),
}).strict()
export type EmailWatchDefinition = z.infer<typeof emailWatchSchema>
export type EmailWatchSummary = EmailWatchDefinition & { id: string; version: number; state: 'active' | 'paused' | 'blocked' | 'removed'; issue?: string | null; nextCheckAt?: number; lastCheckedAt?: number; lastAttemptAt?: number; checking: boolean; consentedAt: number }
export type EmailWatchSettings = { configured: boolean; modelConfigured: boolean; connection: { id: string; email?: string; version: number; readAllowed: boolean } | null; intervalMinutes: number; firstLookbackHours: number; maxBatch: number }
export function watchQuery(senders: string[], from: number, through: number) {
  const clean = emailWatchSchema.shape.senders.parse(senders)
  if (!Number.isFinite(from) || !Number.isFinite(through) || through < from) throw new Error('Invalid email watch window.')
  return `{${clean.map(s => `from:${s}`).join(' ')}} after:${Math.floor(from / 1000)} before:${Math.ceil(through / 1000)} -in:spam -in:trash -in:sent -in:drafts`
}
export function exactSender(header: string) {
  const address = header.trim().match(/^[^<>]*<([^<>]+)>$/)?.[1] ?? header.trim()
  const parsed = sender.safeParse(address)
  return parsed.success ? parsed.data : null
}
