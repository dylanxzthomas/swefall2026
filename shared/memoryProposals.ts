import { familyFactSchema, type FamilyFact } from './memory.js'

export const MEMORY_PROPOSAL_TTL = 30 * 86400_000
export type MemoryProposal = { _id: string; version: number; text: string; value?: FamilyFact; createdAt: number; expiresAt: number }
export type MemoryRequest = { text: string; detail: string }

/** Only an explicit instruction opens memory review; quoted documents are not instructions. */
export function parseMemoryRequest(raw: string): MemoryRequest | null {
  const text = raw.trim()
  if (text.length > 2000) return null
  const match = /^(?:please\s+)?remember\s+(?:that\s+)?(.+)$/i.exec(text)
  if (!match || /\n/.test(text) || !match[1].trim() || /^(?:to\s+|when\b|what\b|how\b|whether\b|if\b)/i.test(match[1]) || /\?$/.test(text)) return null
  return { text, detail: match[1].trim() }
}

export function parseMemoryCandidate(raw: unknown): FamilyFact {
  const parsed = familyFactSchema.parse(raw)
  // Preserve the typed contract even though the older family schema strips extra fields.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !(key in parsed))) throw new Error('Choose a supported household detail, without extra instructions.')
  return parsed
}
