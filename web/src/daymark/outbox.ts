/** Only unsubmitted attachments live here. Server receipts remain authoritative. */
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => { const request = indexedDB.open('daymark-outbox-v1', 1); request.onupgradeneeded = () => request.result.createObjectStore('draft'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
}
export async function readFiles(): Promise<File[]> {
  const db = await open()
  return new Promise((resolve, reject) => { const tx = db.transaction('draft', 'readonly'), request = tx.objectStore('draft').get('attachments'); request.onsuccess = () => resolve((request.result ?? []).map((f: { name: string; type: string; data: Blob }) => new File([f.data], f.name, { type: f.type }))); request.onerror = () => reject(request.error); tx.oncomplete = () => db.close() })
}
export async function saveFiles(files: File[]): Promise<void> {
  const db = await open()
  return new Promise((resolve, reject) => { const tx = db.transaction('draft', 'readwrite'); tx.objectStore('draft').put(files.map(f => ({ name: f.name, type: f.type, data: f.slice() })), 'attachments'); tx.oncomplete = () => { db.close(); resolve() }; tx.onerror = () => reject(tx.error) })
}
