import { z } from 'zod'
/** This contract can change only app records. It contains no provider tool or approval. */
export const workChangeSchema = z.object({
  kind: z.enum(['personal_task', 'private_task', 'request']),
  operation: z.enum(['update', 'done', 'reopen', 'remove', 'cancel', 'revise']),
  version: z.number().int().min(1), snapshot: z.string().min(1).max(100),
  authorization: z.string().trim().min(1).max(2000), target: z.string().trim().min(2).max(200).optional(),
  title: z.string().trim().max(200).optional(),
  text: z.string().trim().max(10000).optional(),
  dueDate: z.string().max(10).nullable().optional(),
}).strict()
export type WorkChange = z.infer<typeof workChangeSchema>
export type WorkItem = { id: string; kind: WorkChange['kind']; version: number; snapshot: string; title: string; text: string; done?: boolean; dueDate?: string; createdAt: number; updatedAt: number; conversation?: boolean; cancelled?: boolean; clarification?: import('./requestClarifications.js').ClarificationQuestion; actions?: { id: string; revision: number; kind: string; status: string; revising: boolean }[] }
const verbs: Record<WorkChange['operation'], RegExp> = {
  update: /\b(?:edit|update|change|rename|reschedule|move|make|set|clear)\b/i,
  done: /\b(?:complete|completed|finish|finished|done|did|mark|check off|tick off)\b/i,
  reopen: /\b(?:reopen|undo|unfinished|not done|incomplete|uncheck)\b/i,
  remove: /\b(?:delete|remove|hide|discard|forget|clear|get rid of)\b/i,
  cancel: /\b(?:cancel|stop|drop|never mind|nevermind)\b/i,
  revise: /\b(?:edit|update|change|rename|reschedule|move|make|set|instead)\b/i,
}
/** A conservative permission check AFTER semantic tool selection, never a router.
 * Mail, old history and quoted/forwarded instructions cannot authorize a write.
 */
export function directWorkAuthorization(source: string, change: WorkChange) {
  const instruction = change.authorization.trim()
  if (!source.includes(instruction) || !verbs[change.operation].test(instruction) || /\b(?:if|unless|when)\b/i.test(source)) return false
  if (/\b(?:sentence|phrase|instruction|command)\b[\s\S]*\b(?:translate|translation|explain|mean|copied|received|quoted)\b|\b(?:translate|translated)\s+(?:to|into)\b/i.test(source)) return false
  const directive = instruction.replace(/^(?:(?:okay|ok|actually|yes|instead|also|on second thought|i changed my mind)[,.!:\s]+)*/i, '')
  if (['remove','cancel','done','reopen'].includes(change.operation)) {
    const clauses = directive.split(/[.!?,;]\s+|\r?\n|\s(?:—|–|--)\s/).map(part => part.trim()).filter(Boolean)
    if (clauses.slice(1).some(part => !/^(?:please|thanks|thank you)[.!?]*$/i.test(part))) return false
  }
  const at = source.indexOf(instruction), prefix = source.slice(0, at), suffix = source.slice(at + instruction.length)
  // Authorization must cover the actual current directive, not a command the
  // model extracted from a notice or reported speech. Only harmless conversational
  // lead-ins and a trailing courtesy may sit outside the exact quotation.
  const leadIn = /^(?:\s*(?:okay|ok|actually|yes|no|instead|also|please|thanks|thank you|on second thought|i changed my mind)[,.!:\s]*)*$/i
  if (!leadIn.test(prefix) || !/^[\s,.!?]*(?:(?:please|thanks|thank you)[\s,.!?]*)?$/i.test(suffix)) return false
  if (change.operation === 'done' && (/\b(?:not|never|haven't|have not|didn't|did not|isn't|is not|wasn't|was not|still need)\b/i.test(source) || /^\s*did\b/i.test(instruction))) return false
  if (/\b(?:do not|don't|dont|never(?!\s+mind\b)|should i|what if|can you explain|how (?:do|can)|example|hypothetical|says?|said|told|asks?|wrote|forwarded|quote|copied|pasted|transcript|attachment|document|email|message reads)\b/i.test(prefix) || /[“"`>]/.test(prefix)) return false
  if (/^(?:if\b|when\b|suppose\b|imagine\b)|\b(?:do not|don't|dont|never(?!\s+mind\b)|should i|what if|if|unless|when|how (?:do|can)|example|hypothetical|said|says|told|wrote|forwarded|quote|not mine|someone else)\b/i.test(instruction)) return false
  // Only an imperative or a direct request counts, rather than a quoted fact.
  const clean = directive.replace(/^(?:please\s+|(?:can|could|would|will) you\s+|i (?:want|need) you to\s+|i(?:'d| would) like you to\s+)*/i, '').replace(change.operation === 'done' ? /^i (?:have )?/i : /$^/, '')
  if (change.operation === 'done' && /^mark\b/i.test(clean) && !/\b(?:done|complete|completed|finished)\b/i.test(clean)) return false
  if (['remove','cancel'].includes(change.operation) && /\b(?:keep|leave|not mine|someone else)\b/i.test(clean)) return false
  if (['remove','cancel'].includes(change.operation) && /\b(?:due date|deadline|notes|description|attachments?|reminders?|notifications?)\b/i.test(clean)) return false
  return new RegExp(`^${verbs[change.operation].source}`, 'i').test(clean) && !/[“"`>]/.test(instruction.slice(0, Math.max(0, instruction.search(verbs[change.operation]))))
}
/** Literal target naming disambiguates duplicate and cross-kind titles. A pronoun
 * is accepted only for the unique most recent request, or one unique task.
 */
export function resolvedWorkTarget(items: WorkItem[], id: string, change: WorkChange): WorkItem | null {
  const reference = bareWorkReference(change)
  const allowedKinds = workTargetKinds(change.authorization, reference ? [] : items, change)
  const candidates = items.filter(item => allowedKinds.includes(item.kind))
  const target = candidates.find(item => item.id === id && item.kind === change.kind)
  if (!target || target.version !== change.version || target.snapshot !== change.snapshot) return null
  const quote = change.authorization.toLocaleLowerCase()
  const fragment = reference ? undefined : change.target?.toLocaleLowerCase()
  if (fragment && !quote.includes(fragment)) return null
  const named = reference ? [] : candidates.filter(item => item.title.trim().length > 1 && (quote.includes(item.title.toLocaleLowerCase()) || !!fragment && (item.title.toLocaleLowerCase().includes(fragment) || item.text.toLocaleLowerCase().includes(fragment))))
  if (named.length) return named.length === 1 && named[0].id === id && destructiveTargetDirective(change, target) ? target : null
  if (!bareWorkReference(change)) return null
  if (change.kind !== 'request') return candidates.length === 1 ? target : null
  if (/\b(?:task|to.do)\b/i.test(quote)) return null
  const substantive = candidates.filter(item => !item.conversation)
  const scope = /\brequest\b/i.test(quote) && substantive.length ? substantive : candidates
  const ordered = [...scope].sort((a, b) => b.createdAt - a.createdAt)
  return ordered[0]?.id === id && (!ordered[1] || ordered[0].createdAt > ordered[1].createdAt) ? target : null
}

/** Scope words come from the parent, never the model's selected kind. */
export function workTargetKinds(authorization: string, items: readonly WorkItem[] = [], change?: Pick<WorkChange, 'title' | 'text'>): WorkChange['kind'][] {
  // A saved title or proposed new wording can itself contain 'private task' or
  // 'request'; those words do not choose which old record the parent means.
  let scopeText = authorization.toLocaleLowerCase()
  const values = [...items.map(item => item.title), change?.title, change?.text].filter((value): value is string => !!value && value.length > 1).sort((a,b) => b.length - a.length)
  for (const value of values) scopeText = scopeText.split(value.toLocaleLowerCase()).join(' saveditem ')
  authorization = scopeText
  if (/\bprivate (?:task|to.do)\b/i.test(authorization)) return ['private_task']
  if (/\b(?:household|shared) (?:task|to.do)\b/i.test(authorization)) return ['personal_task']
  if (/\b(?:request|message)\b/i.test(authorization)) return ['request']
  if (/\b(?:task|to.do)\b/i.test(authorization)) return ['personal_task', 'private_task']
  return ['personal_task', 'private_task', 'request']
}

/** A bare reference is not an arbitrary 'that' embedded in a longer description. */
export function bareWorkReference(change: WorkChange) {
  const clean = change.authorization.replace(/^(?:please\s+|(?:can|could|would|will) you\s+|actually[,\s]+|i (?:want|need) you to\s+)*/i, '').replace(new RegExp(`^${verbs[change.operation].source}\\s+`, 'i'), '')
  const reference = /^(?:it|that(?: task| request| message| one)?|this(?: task| request| message| one)?|(?:the|my) (?:last|latest|previous|most recent)(?: one| task| request| message)?)(?:[.!?]|\s+(?:please|thanks|thank you))*$/i
  if (change.operation === 'remove' || change.operation === 'cancel') return reference.test(clean)
  return reference.test(clean.replace(/\s+(?:to|as|for|done|complete|completed|finished)\b[\s\S]*$/i, ''))
}

/** A destructive directive names the actual saved target; leftover words may
 * scope its removal but cannot turn quoted/transformed instructions into intent. */
function destructiveTargetDirective(change: WorkChange, target: WorkItem) {
  if (!['remove', 'cancel', 'done', 'reopen'].includes(change.operation)) return true
  let rest = change.authorization.replace(/^(?:(?:okay|ok|actually|yes|instead|also|on second thought|i changed my mind)[,.!:\s]+)*/i, '').replace(/^(?:please\s+|(?:can|could|would|will) you\s+|i (?:want|need) you to\s+|i(?:'d| would) like you to\s+)*/i, '').replace(change.operation === 'done' ? /^i (?:have )?/i : /$^/, '').replace(new RegExp(`^${verbs[change.operation].source}\\s+`, 'i'), '').toLocaleLowerCase()
  const phrases = [target.title, ...(change.target && target.title.toLocaleLowerCase().includes(change.target.toLocaleLowerCase()) ? [change.target] : []), ...(target.kind === 'request' && target.text.split('\n')[0].length <= 200 ? [target.text.split('\n')[0]] : [])].filter(Boolean).sort((a,b) => b.length - a.length)
  for (const phrase of phrases) {
    if (!rest.includes(phrase.toLocaleLowerCase())) continue
    const outside = rest.replace(phrase.toLocaleLowerCase(), '').replace(/[“”"'`.,!?]/g, ' ').trim()
    if (outside.split(/\s+/).every(word => !word || ['the','my','our','this','that','task','tasks','to-do','todo','request','message','private','personal','household','shared','from','conversation','list','active','work','please','thanks','thank','you','on',...(change.operation === 'done' ? ['done','complete','completed','finished','off'] : []),...(change.operation === 'reopen' ? ['open','unfinished','incomplete','again'] : [])].includes(word))) return true
  }
  return false
}
