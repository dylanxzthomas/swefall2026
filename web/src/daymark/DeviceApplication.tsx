import { useEffect, useState, useSyncExternalStore } from 'react'
import Daymark from './Daymark'
import { createDeviceStore } from './deviceStore'

export default function DeviceApplication({ signIn }: { signIn?: () => Promise<void> }) {
  const [store] = useState(() => createDeviceStore(signIn)), [error, setError] = useState('')
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useEffect(() => { void store.load().catch(e => setError(e.message)); return store.close }, [store])
  return <>{error && <p className="dm-error" role="alert">{error}</p>}<Daymark state={{ ...state, accountAvailable: !!signIn }} client={store.client} /></>
}
