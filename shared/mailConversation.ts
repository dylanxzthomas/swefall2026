/** Select cached email context without widening access or initiating a provider read. */
export function needsMailConversation(text: string, mailFocused: boolean): boolean {
  const value = text.trim().replace(/[.!?]+$/, '').replace(/\s+/g, ' ')
  if (/\b(?:gmail|inbox|mailbox|emails?)\b/i.test(value)) return true
  if (!mailFocused || value.length > 250) return false
  // Short references continue the latest email discussion. A new topic with its
  // own object (such as dinner) does not inherit private mailbox excerpts.
  if (/^(?:why|how so|tell me more|explain(?: more)?|just in general|what next|what else|anything else)$/i.test(value)) return true
  return /\b(?:it|that|those|these|them|one|ones|first|second|third)\b/i.test(value)
    && /^(?:what|which|when|where|who|how|why|is|are|does|do|can|could|would|should|please|make|rewrite|shorten|explain|tell|draft|reply|suggest|summari[sz]e)\b/i.test(value)
}
