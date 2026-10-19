import { useRef, useState } from 'react'
import { privateTaskInputSchema, type PrivateTask, type PrivateTaskInput } from '../../../shared/privateTasks'
export type PrivateTaskActions = {
  onUpdate(id: string, version: number, input: PrivateTaskInput): Promise<number>
  onSetDone(id: string, version: number, done: boolean): Promise<number>
  onRemove(id: string, version: number): Promise<unknown>
}
export default function PrivateTasks({ tasks, limited = false, ...actions }: { tasks: PrivateTask[]; limited?: boolean } & PrivateTaskActions) {
  const [selected, setSelected] = useState<string | null>(null)
  if (!tasks.length) return null
  return <section aria-label="Private tasks"><h3>Just for you</h3><p className="dm-muted">Tasks you chose to keep privately. They stay saved until you remove them, even after the original email or conversation expires.</p>{limited && <p className="dm-notice">Showing your 200 most recent private tasks. Older saved tasks remain stored.</p>}{tasks.map(task => <section className="dm-setting-item" key={task.id}>{selected === task.id ? <PrivateTaskReview task={task} {...actions} close={() => setSelected(null)} /> : <><strong>{task.title}</strong><p className="dm-muted">{task.done ? 'Done by you' : 'For you to do'}</p><button onClick={() => setSelected(task.id)}>{task.done ? 'Review completed task' : 'Open task'}</button></>}</section>)}</section>
}
function PrivateTaskReview({ task, close, onUpdate, onSetDone, onRemove }: { task: PrivateTask; close(): void } & PrivateTaskActions) {
  const [input, setInput] = useState<PrivateTaskInput>({ title: task.title, text: task.text }), [version, setVersion] = useState(task.version), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), [removing, setRemoving] = useState(false), pending = useRef(false)
  const stale = task.version !== version
  const run = async (operation: () => Promise<unknown>) => { if (pending.current || stale) return; pending.current = true; setBusy(true); setError(''); try { await operation() } catch (cause) { setError(cause instanceof Error ? cause.message : 'The task could not be updated. Your edits are still here.') } finally { pending.current = false; setBusy(false) } }
  const change = (patch: Partial<PrivateTaskInput>) => { setInput({ ...input, ...patch }); setSaved(false) }
  const complete = async () => { const checked = privateTaskInputSchema.parse(input), next = checked.title !== task.title || checked.text !== task.text ? await onUpdate(task.id, version, checked) : version; setVersion(next); await onSetDone(task.id, next, !task.done); close() }
  return <section className="dm-fields" aria-label="Edit private task"><fieldset disabled={busy || stale}><label>Task<input maxLength={200} value={input.title} onChange={event => change({ title: event.target.value })} /></label><label>Details<textarea maxLength={10000} rows={4} value={input.text} onChange={event => change({ text: event.target.value })} /></label></fieldset>{stale && <p role="alert">This task changed elsewhere. Your edits are still here; close and reopen it before saving.</p>}{saved && <p role="status">Task saved privately.</p>}{error && <p role="alert">{error}</p>}
    <div className="dm-actions"><button disabled={busy || stale} onClick={() => void run(async () => { setVersion(await onUpdate(task.id, version, privateTaskInputSchema.parse(input))); setSaved(true) })}>{busy ? 'Saving…' : 'Save edits'}</button><button disabled={busy || stale} onClick={() => void run(complete)}>{task.done ? 'Reopen task' : 'Mark done'}</button><button disabled={busy} onClick={close}>Done</button></div>
    {removing ? <div><p>Remove this private task? Its saved text will be erased.</p><div className="dm-actions"><button disabled={busy || stale} onClick={() => void run(async () => { await onRemove(task.id, version); close() })}>Remove task</button><button disabled={busy} onClick={() => setRemoving(false)}>Keep task</button></div></div> : <button disabled={busy || stale} onClick={() => setRemoving(true)}>Remove task</button>}
  </section>
}
