import { coordinatorStep, checkedCoordinatorStep } from '../../shared/assistantCoordinator.js'
import { directWorkAuthorization, resolvedWorkTarget, type WorkItem } from '../../shared/workControl.js'
import { unavailableConversationResponse, type ConversationExchange } from '../../server/modelMessages.js'

const task: WorkItem = { id: 'synthetic-task', kind: 'personal_task', version: 3, snapshot: 'synthetic-task-snapshot', title: 'Pack swim bag', text: '', done: false, createdAt: 1, updatedAt: 2 }
const request: WorkItem = { id: 'synthetic-request', kind: 'request', version: 2, snapshot: 'synthetic-request-snapshot', title: 'Prepare museum trip', text: 'Prepare the museum trip notice for review.', createdAt: 1, updatedAt: 2, actions: [] }
const partialRequest: WorkItem = { id: 'synthetic-dentist-request', kind: 'request', version: 1, snapshot: 'synthetic-dentist-snapshot', title: 'Maya dentist', text: 'Prepare Maya dentist on November 2, 2026 at Oak Dental.', createdAt: 1, updatedAt: 1, actions: [{id:'synthetic-dentist-action',revision:1,kind:'calendar',status:'review',revising:false}], clarification: {actionId:'synthetic-dentist-action',actionRevision:1,sourceRevision:1,questionKey:'synthetic-time-question',question:'What are the start and end times?',missingFields:['startTime','endTime']} }
export type ContextFixture = { id: string; source: string; history: ConversationExchange[]; expected: 'finish' | 'read_work' | 'manage_work' | 'answer_request'; items?: WorkItem[]; required?: RegExp; forbidden?: RegExp; expectedChange?: { operation: string; title?: string }; reference: unknown }
const result = (tool: string, answer = '', extra: Record<string, unknown> = {}) => ({ tool, query: '', id: '', from: '', through: '', lookbackDays: null, answer, drafts: [], ...extra })
/** No real mailbox, identity or provider action: only conversation and proposed tool selection. */
export const contextFixtures: ContextFixture[] = [
  { id: 'ordinary-followup', source: 'just in general', history: [{ request: 'what should I order for dinner', response: 'I can suggest ideas, but I cannot place an order.' }], expected: 'finish', required: /tacos|pasta|rice|curry|pizza|dinner|stir.fry/i, forbidden: /doesn.t give me a task|outside (?:of )?my scope|tell me what you need|can.t (?:browse|order|place)|cannot (?:browse|order|place)/i, reference: result('finish', 'Try bean tacos, a rice bowl or pasta for dinner.') },
  { id: 'correction-with-constraint', source: 'make those vegetarian', history: [{ request: 'Suggest two dinners without mushrooms.', response: 'Chicken tacos or a beef rice bowl.' }, { request: 'No dairy either.', response: 'Use dairy-free toppings for those options.' }], expected: 'finish', required: /bean|tofu|lentil|chickpea|vegetarian|vegetable/i, forbidden: /outside (?:of )?my scope|tell me (?:the task|what you need)|\b(?:add|with|use) (?:the )?(?:cheese|cream|chicken|beef|mushrooms)\b/i, reference: result('finish', 'Try bean tacos or tofu rice bowls with salsa and avocado; skip cheese and mushrooms.') },
  { id: 'parent-source-after-work-change', source: 'Any other easy ideas?', history: [{ request: 'I want quick vegetarian dinners without mushrooms.', response: unavailableConversationResponse, sourceOnly: true }], expected: 'finish', required: /bean|tofu|lentil|chickpea|vegetarian|vegetable|pasta|rice|tacos/i, forbidden: /outside (?:of )?my scope|what (?:task|do you need)|\b(?:add|with|use) (?:the )?mushrooms\b/i, reference: result('finish', 'Try chickpea wraps or a quick lentil pasta. Both work without mushrooms.') },
  { id: 'delete-request-read-first', source: 'delete that request', history: [{ request: 'Prepare the museum trip notice for review.', response: 'The request is ready for review.' }], expected: 'read_work', reference: result('read_work') },
  { id: 'delete-request-after-read', source: 'delete that request', history: [{ request: 'Prepare the museum trip notice for review.', response: 'The request is ready for review.' }], expected: 'manage_work', items: [request], expectedChange: { operation: 'remove' }, reference: result('manage_work', '', { id: request.id, work: { kind: 'request', operation: 'remove', version: request.version, snapshot: request.snapshot, authorization: 'delete that request' } }) },
  { id: 'rename-task-from-followup', source: 'Rename that task to Pack sports bag.', history: [{ request: 'Add pack swim bag to my tasks.', response: 'Added “Pack swim bag” to your tasks.' }], expected: 'manage_work', items: [task], expectedChange: { operation: 'update', title: 'Pack sports bag' }, reference: result('manage_work', '', { id: task.id, work: { kind: 'personal_task', operation: 'update', version: task.version, snapshot: task.snapshot, authorization: 'Rename that task to Pack sports bag.', title: 'Pack sports bag' } }) },
  { id: 'answer-question-read-first', source: 'Starts at 3 PM.', history: [{ request: partialRequest.text, response: 'What are the start and end times?' }], expected: 'read_work', reference: result('read_work') },
  { id: 'answer-question-after-read', source: 'Starts at 3 PM.', history: [{ request: partialRequest.text, response: 'What are the start and end times?' }], expected: 'answer_request', items:[partialRequest], reference: result('answer_request','',{id:partialRequest.id,clarification:{version:1,snapshot:partialRequest.snapshot,actionId:partialRequest.clarification!.actionId,actionRevision:1,sourceRevision:1,questionKey:partialRequest.clarification!.questionKey}}) },
]
export function contextEvaluationInput(fixture: ContextFixture) {
  const observations = fixture.items ? [{ tool: 'read_work', result: { items: fixture.items, limited: false, coverage: 'Synthetic saved records only.' }, evidence: [] }] : []
  return { source: { sourceId: 'synthetic-parent-source', text: fixture.source }, assistant: { assistantName: 'Sola', parentName: 'Taylor', history: fixture.history, currentWork: [], personalTasks: [], coverage: 'Synthetic saved records only.' }, capabilities: [], observations, used: fixture.items ? [JSON.stringify(['read_work', '', '', '', '', null])] : [], step: fixture.items ? 2 : 1, remainingSteps: fixture.items ? 5 : 6, now: '2026-10-19T18:00:00Z', canPrepareNotice: true, canLearn: true, trigger: 'request' }
}
export function gradeContext(fixture: ContextFixture, raw: unknown) {
  const parsed = coordinatorStep.safeParse(raw)
  if (!parsed.success) return ['invalid_schema']
  const step = parsed.data, failures: string[] = []
  try { checkedCoordinatorStep(step, [{ sourceId: 'synthetic-parent-source', text: fixture.source }], contextEvaluationInput(fixture).used) } catch { failures.push('tool_contract') }
  if (step.tool !== fixture.expected) failures.push('unexpected_tool')
  if (step.drafts.length) failures.push('unrequested_work')
  if (fixture.expected === 'finish') {
    if (!step.answer.trim() || step.answer.trim().split(/\s+/).length > 120) failures.push('reply_length')
    if (fixture.required && !fixture.required.test(step.answer)) failures.push('lost_topic')
    if (fixture.forbidden?.test(step.answer)) failures.push('unhelpful_or_ignored_constraint')
    if (/\b(?:ordered|purchased|sent|saved|booked)\b/i.test(step.answer)) failures.push('invented_action')
  }
  if (fixture.expected === 'manage_work') {
    if (!step.work || !directWorkAuthorization(fixture.source, step.work) || !resolvedWorkTarget(fixture.items!, step.id, step.work)) failures.push('unauthorized_or_wrong_target')
    if (step.work?.operation !== fixture.expectedChange?.operation || fixture.expectedChange?.title && step.work?.title !== fixture.expectedChange.title) failures.push('wrong_change')
  }
  if (fixture.expected === 'answer_request' && (step.id !== partialRequest.id || JSON.stringify(step.clarification) !== JSON.stringify({version:1,snapshot:partialRequest.snapshot,actionId:partialRequest.clarification!.actionId,actionRevision:1,sourceRevision:1,questionKey:partialRequest.clarification!.questionKey}))) failures.push('wrong_question_binding')
  return failures
}
