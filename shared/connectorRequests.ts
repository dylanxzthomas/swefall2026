import { z } from 'zod'

export const connectorRequestSchema = z.object({
  service: z.string().trim().max(100, 'Keep the service name under 100 characters.').optional().transform(value => value || undefined),
  outcome: z.string().trim().min(1, 'Describe what you want Sola to help with.').max(2000, 'Keep the request under 2,000 characters.'),
}).strict()
export type ConnectorRequestInput = z.input<typeof connectorRequestSchema>
export type ConnectorRequest = z.output<typeof connectorRequestSchema> & { id: string; version: number; status: 'requested' | 'dismissed'; createdAt: number; updatedAt: number }
export const connectorRequestLimit = 100
export function connectorRequestKey(input: ConnectorRequestInput) {
  const value = connectorRequestSchema.parse(input)
  const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase()
  return JSON.stringify([normalize(value.service ?? ''), normalize(value.outcome)])
}
export function connectorRequestId(value: string) {
  const id = value.trim()
  if (!id || id.length > 100) throw new Error('This connector request needs a valid identifier.')
  return id
}
