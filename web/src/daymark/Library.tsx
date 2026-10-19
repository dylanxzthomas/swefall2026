import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CalendarBlank, CaretDown, DotsThree, DownloadSimple, EnvelopeSimple, FilePdf, FileText, FolderSimple, Images, MagnifyingGlass, Plus, PushPin, UsersThree, X } from '@phosphor-icons/react'
import ArtifactPreview, { noticeDate } from './ArtifactPreview'
import type { DaymarkClient, DaymarkState, Deliverable, LibraryItem } from './types'
import './library.css'

type Props = { state: DaymarkState; client: DaymarkClient; openJob(jobId: string): void; compose(): void }
const message = (error: unknown) => error instanceof Error ? error.message : 'This could not be saved. Your previous items are still available.'
const isImage = (type?: string) => type === 'image/jpeg' || type === 'image/png'
const fileSize = (size?: number) => size === undefined ? '' : size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`
function work(state: DaymarkState, item: LibraryItem) {
  const job = state.jobs.find(job => job._id === item.jobId)
  return { job, action: job?.actions.find(action => action._id === item.actionId) }
}
function workStatus(action?: Deliverable, cancelled = false) {
  if (!action) return 'Original work unavailable'
  if (cancelled || action.status === 'cancelled') return 'Cancelled'
  if (action.revisionRequest) return 'Revising draft'
  if (action.status === 'saved') return action.payload.kind === 'calendar' ? 'Saved to device plan' : action.payload.kind === 'email' ? 'Draft · not sent' : 'Draft · caregiver not contacted'
  if (action.status === 'succeeded') {
    if (action.payload.kind === 'email') return action.receipts.some(receipt => receipt.outcome === 'microsoft_accepted') ? 'Outlook accepted · delivery unverified' : 'Email accepted by provider'
    if (action.payload.kind === 'pickup') return 'Caregiver acceptance recorded'
    return action.receipts.some(receipt => receipt.outcome.startsWith('apple_calendar_')) ? 'Verified on the connected iPhone' : 'Calendar change verified'
  }
  return ({ review: action.payload.kind === 'email' ? 'Draft · not sent' : 'Ready for review', queued: 'Approved · waiting to run', executing: 'Working', uncertain: 'Result unconfirmed', failed: 'Needs your attention', waiting: 'Awaiting caregiver response' } as Record<string, string>)[action.status] ?? 'Saved work'
}
function summary(action?: Deliverable) {
  if (!action) return 'The original request is no longer available.'
  const payload = action.payload
  if (payload.kind === 'email') return payload.body || 'No message written yet.'
  return [noticeDate(payload.date), payload.location].filter(Boolean).join(' · ')
}
function Sheet({ title, close, children }: { title: string; close(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { const element = dialog.current; if (element && !element.open) element.showModal(); return () => element?.close() }, [])
  return <dialog ref={dialog} className="dm-sheet dm-library-sheet" aria-label={title} onCancel={event => { event.preventDefault(); close() }}>
    <header><h2>{title}</h2><button onClick={close} aria-label="Close library details">Done</button></header>{children}
  </dialog>
}
function Thumbnail({ item, client }: { item: LibraryItem; client: DaymarkClient }) {
  const host = useRef<HTMLSpanElement>(null), reader = useRef(client.readLibraryFile)
  const [url, setUrl] = useState(''), [failed, setFailed] = useState(false)
  reader.current = client.readLibraryFile
  useEffect(() => {
    setUrl(''); setFailed(false)
    if (!isImage(item.mediaType) || !reader.current) return
    let cancelled = false, started = false, objectUrl = ''
    const load = () => {
      if (started) return; started = true
      void reader.current!(item.id).then(blob => { if (!cancelled) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl) } }).catch(() => { if (!cancelled) setFailed(true) })
    }
    const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { load(); observer?.disconnect() } }, { rootMargin: '120px' }) : null
    if (observer && host.current) observer.observe(host.current); else load()
    return () => { cancelled = true; observer?.disconnect(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [item.id, item.mediaType])
  const Icon = item.mediaType === 'application/pdf' ? FilePdf : Images
  return <span ref={host} className="dm-library-thumbnail">{url && !failed ? <img src={url} alt={item.title} loading="lazy" onError={() => setFailed(true)} /> : <><Icon size={34} weight="light" aria-hidden="true" /><span>{failed ? 'Preview unavailable' : item.mediaType === 'application/pdf' ? 'PDF' : item.mediaType === 'image/heic' ? 'HEIC image' : 'Image'}</span></>}</span>
}
function MediaPreview({ item, client }: { item: LibraryItem; client: DaymarkClient }) {
  const reader = useRef(client.readLibraryFile), [url, setUrl] = useState(''), [error, setError] = useState(''), [imageFailed, setImageFailed] = useState(false)
  reader.current = client.readLibraryFile
  useEffect(() => {
    let cancelled = false, objectUrl = ''
    setError(''); setUrl(''); setImageFailed(false)
    if (!reader.current) { setError('File access is unavailable in this workspace.'); return }
    void reader.current(item.id).then(blob => { if (!cancelled) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl) } }).catch(failure => { if (!cancelled) setError(message(failure)) })
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [item.id])
  const extension = item.mediaType === 'application/pdf' ? '.pdf' : item.mediaType === 'image/jpeg' ? '.jpg' : item.mediaType === 'image/png' ? '.png' : '.heic'
  const downloadName = /\.(pdf|jpe?g|png|heic)$/i.test(item.title) ? item.title : item.title + extension
  return <div className="dm-library-preview">
    {error ? <p role="alert" className="dm-error">{error}</p> : !url ? <p role="status" className="dm-muted">Opening file…</p> : <>
      {isImage(item.mediaType) && !imageFailed ? <img src={url} alt={item.title} onError={() => setImageFailed(true)} /> : item.mediaType === 'application/pdf' ? <iframe src={url} title={item.title} sandbox="" /> : <div className="dm-library-preview-fallback"><Images size={32} aria-hidden="true" /><p>{imageFailed ? 'This image could not be previewed.' : 'This image format is available to download.'}</p></div>}
      <a className="dm-library-download" href={url} download={downloadName}><DownloadSimple size={18} aria-hidden="true" />Download {item.mediaType === 'application/pdf' ? 'PDF' : 'image'}</a>
      {item.mediaType === 'application/pdf' && <p className="dm-library-footnote">If the preview is blank, download the PDF to open it.</p>}
    </>}
  </div>
}
function ItemDetails({ item, state, client, collections, close, openJob }: { item: LibraryItem; state: DaymarkState; client: DaymarkClient; collections: string[]; close(): void; openJob(jobId: string): void }) {
  const [title, setTitle] = useState(item.title), [collection, setCollection] = useState(item.collection), [childId, setChildId] = useState(item.childId ?? ''), [pinned, setPinned] = useState(item.pinned)
  const [version, setVersion] = useState(item.version), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), [confirmRemove, setConfirmRemove] = useState(false)
  const current = work(state, item)
  const stale = item.version > version, awaitingUpdate = item.version < version
  const blocked = stale || awaitingUpdate
  const update = async () => {
    if (blocked || busy) return
    if (!client.updateLibrary) { setError('Library editing is unavailable in this workspace.'); return }
    setBusy(true); setError(''); setSaved(false)
    try { await client.updateLibrary(item.id, version, { title: title.trim(), collection: collection.trim(), childId: childId || undefined, pinned }); setVersion(version + 1); setSaved(true) }
    catch (failure) { setError(message(failure)) } finally { setBusy(false) }
  }
  const remove = async () => {
    if (blocked || busy) return
    if (!client.removeLibrary) { setError('Library editing is unavailable in this workspace.'); return }
    setBusy(true); setError('')
    try { await client.removeLibrary(item.id, version); close() } catch (failure) { setError(message(failure)); setBusy(false) }
  }
  return <Sheet title={item.kind === 'media' ? 'Saved file' : 'Saved work'} close={() => { if (!busy) close() }}>
    <div className="dm-library-detail-title"><h3>{item.title}</h3><p>{item.collection || 'Unfiled'}{item.size !== undefined ? ` · ${fileSize(item.size)}` : ''}</p></div>
    {item.kind === 'media' ? <MediaPreview item={item} client={client} /> : current.action ? <>
      <p className="dm-library-status">{workStatus(current.action, current.job?.cancelled)}</p>
      <ArtifactPreview payload={current.action.payload} state={state} compact />
      <button className="dm-primary dm-library-open" onClick={() => { close(); openJob(current.job!._id) }}>Open request</button>
    </> : <p className="dm-notice">The original request is no longer available. This entry does not confirm an action was completed.</p>}
    {stale && <p role="alert" className="dm-notice">This item changed elsewhere. Close and reopen its details before saving or removing it.</p>}
    {awaitingUpdate && <p role="status" className="dm-muted">Updating saved details…</p>}
    <details className="dm-library-edit" open={item.kind === 'artifact' && !current.action || undefined}>
      <summary>Edit details</summary>
      <form onSubmit={event => { event.preventDefault(); void update() }} onChange={() => setSaved(false)}>
        <label>Title<input value={title} maxLength={200} required onChange={event => setTitle(event.target.value)} /></label>
        <label>Collection<input value={collection} list="library-edit-collections" maxLength={80} placeholder="Unfiled" onChange={event => setCollection(event.target.value)} /></label>
        <datalist id="library-edit-collections">{collections.map(value => <option value={value} key={value} />)}</datalist>
        <label>Child<select value={childId} onChange={event => setChildId(event.target.value)}><option value="">Whole family</option>{state.household?.children.map(child => <option value={child.id} key={child.id}>{child.name}</option>)}</select></label>
        <label className="dm-check"><input type="checkbox" checked={pinned} onChange={event => setPinned(event.target.checked)} />Pin to top</label>
        <button type="submit" className="dm-primary" disabled={busy || !title.trim() || blocked}>{busy ? 'Saving…' : 'Save details'}</button>
        {saved && !blocked && <p role="status" className="dm-library-saved">Details saved.</p>}
      </form>
    </details>
    {error && <p role="alert" className="dm-error">{error}</p>}
    <div className="dm-library-remove">{confirmRemove ? <>
      <p>{item.kind === 'artifact' ? 'Remove this saved entry? The request, calendar, and messages stay in place.' : 'Remove this file from Library? Any original notice stays in place.'}</p>
      <div className="dm-actions"><button disabled={busy || blocked} onClick={() => void remove()}>Remove from Library</button><button disabled={busy} onClick={() => setConfirmRemove(false)}>Keep it</button></div>
    </> : <button className="dm-text-button" disabled={busy || blocked} onClick={() => setConfirmRemove(true)}>Remove from Library</button>}</div>
  </Sheet>
}
export default function Library({ state, client, openJob, compose }: Props) {
  const [tab, setTab] = useState<'artifact' | 'media'>('artifact'), [query, setQuery] = useState(''), [filter, setFilter] = useState(''), [selectedId, setSelectedId] = useState<string | null>(null)
  const [files, setFiles] = useState<File[]>([]), [uploadCollection, setUploadCollection] = useState(''), [uploadChild, setUploadChild] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const items = state.library ?? [], collections = [...new Set(items.map(item => item.collection).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const selected = items.find(item => item.id === selectedId)
  const available = Boolean(client.uploadLibrary && client.updateLibrary && client.removeLibrary)
  const loading = state.loading || state.library === undefined && available
  const needle = query.trim().toLocaleLowerCase()
  const visible = items.filter(item => item.kind === tab && (!filter || item.collection === filter) && (!needle || [item.title, item.collection, state.household?.children.find(child => child.id === item.childId)?.name ?? '', item.kind === 'artifact' ? summary(work(state, item).action) : ''].join(' ').toLocaleLowerCase().includes(needle))).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt)
  const addFiles = () => { setError(''); input.current?.click() }
  const upload = async () => {
    if (!client.uploadLibrary) { setError('Saving files is unavailable in this workspace.'); return }
    setBusy(true); setError('')
    try { await client.uploadLibrary(files, uploadCollection.trim(), uploadChild || undefined); setFiles([]); setTab('media'); setFilter(uploadCollection.trim()); setQuery('') }
    catch (failure) { setError(message(failure)) } finally { setBusy(false) }
  }
  return <section className="dm-library" aria-label="Library">
    <div className="dm-page-heading dm-library-heading"><div><h2>Library</h2><p>Work and files, kept close.</p></div><button className="dm-icon-button" aria-label="Add files to Library" title="Add files" disabled={!available} onClick={addFiles}><Plus size={23} aria-hidden="true" /></button></div>
    <input ref={input} className="dm-sr-only" aria-label="Choose Library files" type="file" accept="image/jpeg,image/png,image/heic,application/pdf,.heic" multiple onChange={event => { const chosen = Array.from(event.target.files ?? []); event.target.value = ''; if (chosen.length) { setFiles(chosen); setUploadCollection(filter); setUploadChild(''); setError('') } }} />
    <div className="dm-segmented" aria-label="Library view">{(['artifact', 'media'] as const).map(value => <button key={value} aria-pressed={tab === value} onClick={() => { setTab(value); setQuery(''); setError('') }}>{value === 'artifact' ? 'Saved work' : 'Media'}</button>)}</div>
    <div className="dm-library-tools"><label className="dm-library-search"><MagnifyingGlass size={18} aria-hidden="true" /><input type="search" aria-label="Search Library" placeholder={tab === 'artifact' ? 'Search saved work' : 'Search files'} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label className="dm-library-filter"><FolderSimple size={18} aria-hidden="true" /><select aria-label="Library collection" value={filter} onChange={event => setFilter(event.target.value)}><option value="">All collections</option>{collections.map(value => <option value={value} key={value}>{value}</option>)}</select><CaretDown size={12} aria-hidden="true" /></label>
    </div>
    {!available && <p className="dm-notice">Library is unavailable in this workspace. Your existing requests are still available in Assistant.</p>}
    {error && !files.length && <p className="dm-error" role="alert">{error}</p>}
    {loading ? <div className="dm-library-loading" role="status"><span>Loading your library…</span><div /><div /></div> : visible.length ? <>
      <p className="dm-library-count">{filter || (tab === 'artifact' ? 'Saved work' : 'Media')}<span>{visible.length}</span></p>
      <div className={tab === 'media' ? 'dm-library-media' : 'dm-library-work'}>{visible.map(item => {
        const { job, action } = work(state, item), child = state.household?.children.find(child => child.id === item.childId)?.name
        const Icon = action?.payload.kind === 'calendar' ? CalendarBlank : action?.payload.kind === 'email' ? EnvelopeSimple : action?.payload.kind === 'pickup' ? UsersThree : FileText
        return <article key={item.id} className={item.kind === 'media' ? 'dm-library-file' : 'dm-library-artifact'}>
          {item.kind === 'media' ? <button className="dm-library-file-main" aria-label={`Open ${item.title}`} onClick={() => setSelectedId(item.id)}><Thumbnail item={item} client={client} /><strong>{item.title}</strong><span>{[item.collection, child, fileSize(item.size)].filter(Boolean).join(' · ') || 'Saved file'}</span></button> : <button className="dm-library-artifact-main" onClick={() => job && action ? openJob(job._id) : setSelectedId(item.id)}>
            <span className="dm-library-work-icon"><Icon size={22} aria-hidden="true" /></span><span className="dm-library-work-copy"><span className="dm-library-status">{workStatus(action, job?.cancelled)}</span><strong>{item.title}</strong><span className="dm-library-excerpt">{summary(action)}</span>{(item.collection || child) && <small>{[item.collection, child].filter(Boolean).join(' · ')}</small>}</span>
          </button>}
          <div className="dm-library-item-actions">{item.pinned && <PushPin size={14} aria-label="Pinned" weight="fill" />}<button className="dm-icon-button" aria-label={`Edit ${item.title}`} onClick={() => setSelectedId(item.id)}><DotsThree size={22} weight="bold" aria-hidden="true" /></button></div>
        </article>
      })}</div>
    </> : <div className="dm-library-empty">{query || filter ? <><MagnifyingGlass size={28} weight="light" aria-hidden="true" /><h3>No matches</h3><p>Try another search or collection.</p><button className="dm-text-button" onClick={() => { setQuery(''); setFilter('') }}>Clear filters</button></> : tab === 'artifact' ? <><FolderSimple size={30} weight="light" aria-hidden="true" /><h3>A place for useful work.</h3><p>Save calendar changes, replies, and pickup requests from review to find them here.</p><button className="dm-text-button" onClick={compose}>Start a request</button></> : <><Images size={30} weight="light" aria-hidden="true" /><h3>School files, together.</h3><p>Keep notices, forms, and photos here. Add your own files or save one from a request.</p><button className="dm-text-button" disabled={!available} onClick={addFiles}>Add files</button></>}</div>}
    <p className="dm-library-footnote">{state.storage === 'device' ? 'Kept on this device until you remove them.' : 'Kept in your household until you remove them.'} Saving work here does not approve or send it.</p>
    {selected && <ItemDetails key={selected.id} item={selected} state={state} client={client} collections={collections} close={() => setSelectedId(null)} openJob={openJob} />}
    {!!files.length && <Sheet title="Add to Library" close={() => { if (!busy) { setFiles([]); setError('') } }}><p className="dm-muted">Up to five images or one PDF, 10 MB total.</p><ul className="dm-library-upload-files">{files.map((file, index) => <li key={`${file.name}:${index}`}><FileText size={19} aria-hidden="true" /><span>{file.name}<small>{fileSize(file.size)}</small></span><button className="dm-icon-button" aria-label={`Remove ${file.name} from upload`} disabled={busy} onClick={() => setFiles(files.filter((_, at) => at !== index))}><X size={17} aria-hidden="true" /></button></li>)}</ul>
      <form onSubmit={event => { event.preventDefault(); void upload() }}><label>Collection<input value={uploadCollection} list="library-upload-collections" maxLength={80} placeholder="Unfiled" onChange={event => setUploadCollection(event.target.value)} /></label><datalist id="library-upload-collections">{collections.map(value => <option value={value} key={value} />)}</datalist><label>Child<select value={uploadChild} onChange={event => setUploadChild(event.target.value)}><option value="">Whole family</option>{state.household?.children.map(child => <option value={child.id} key={child.id}>{child.name}</option>)}</select></label>{error && <p className="dm-error" role="alert">{error}</p>}<button className="dm-primary dm-library-open" type="submit" disabled={busy}>{busy ? 'Saving files…' : `Add ${files.length === 1 ? 'file' : `${files.length} files`}`}</button></form>
    </Sheet>}
  </section>
}
export { Library }
