import { useCallback, useEffect, useRef, useState } from 'react'
import { useConvex, useMutation, useQuery } from 'convex/react'
import { App } from '@capacitor/app'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import { nativeCalendar } from './nativeCalendar'
import { nativeEventPayload, type NativeCalendarResult, type NativeCalendarState } from '../../../shared/nativeCalendar'
import type { DaymarkState } from './types'

export function useAppleCalendar(ready: boolean, accounts: DaymarkState['accounts']) {
  const convex = useConvex(), register = useMutation(api.apple.register), choose = useMutation(api.connections.choose), disconnect = useMutation(api.connections.disconnect)
  const [installation, setInstallation] = useState(''), [permission, setPermission] = useState<Omit<NativeCalendarState, 'version' | 'selectedId'>>(), [error, setError] = useState(''), [foreground, setForeground] = useState(true), [resume, setResume] = useState(0)
  const busy = useRef(new Set<string>()), checked = useRef(new Set<string>()), active = useRef(ready)
  active.current = ready
  const pending = useQuery(api.apple.pending, ready && installation && nativeCalendar.available() ? { deviceId: installation } : 'skip')
  const current = accounts?.items.find(c => c.id === accounts.calendarId)
  const local = accounts?.items.find(c => c.provider === 'apple' && c.nativeDeviceId === installation)
  const selected = current?.provider === 'apple' && current.nativeDeviceId === installation ? current : undefined
  const state: NativeCalendarState | undefined = permission ? { ...permission, selectedId: selected?.calendarId, version: selected?.version ?? local?.version ?? 0 } : undefined
  const refreshPermission = useCallback(async () => {
    if (!nativeCalendar.available()) return
    const value = await nativeCalendar.status(); setPermission({ ...value, available: true })
  }, [])
  useEffect(() => {
    if (!nativeCalendar.available()) return
    let cancelled = false
    void Promise.all([nativeCalendar.installation(), nativeCalendar.status()]).then(([deviceId, status]) => { if (!cancelled) { setInstallation(deviceId); setPermission({ ...status, available: true }) } }).catch(() => { if (!cancelled) setError('The Apple Calendar connection could not be restored. Unlock this iPhone and reopen Daymark.') })
    const retry = () => { checked.current.clear(); setResume(value => value + 1) }
    window.addEventListener('online', retry)
    const listener = App.addListener('appStateChange', value => { setForeground(value.isActive); if (value.isActive) { retry(); void refreshPermission().catch(() => setError('Check Calendar permission in iPhone Settings.')) } })
    return () => { cancelled = true; window.removeEventListener('online', retry); void listener.then(value => value.remove()) }
  }, [refreshPermission])
  const run = useCallback(async (actionId: string, readOnly: boolean) => {
    if (!ready || !installation || busy.current.has(actionId)) return
    busy.current.add(actionId)
    try {
      const args = { actionId: actionId as Id<'actions'>, deviceId: installation }
      const data = readOnly ? await convex.query(api.apple.context, args) : await convex.action(api.apple.claim, args)
      if (!data?.attemptId) return
      let result: NativeCalendarResult
      if (readOnly) result = await nativeCalendar.reconcile(data.operation)
      else {
        const dispatched = await convex.action(api.apple.dispatch, { ...args, attemptId: data.attemptId })
        if (!dispatched) return
        if (!active.current) return // The attempt remains visible for read-only recovery after sign-in.
        result = await nativeCalendar.execute(data.operation)
      }
      const { verifiedAt: _localTime, ...evidence } = result
      await convex.mutation(api.apple.finish, { ...args, attemptId: data.attemptId, ...evidence }); setError('')
    } catch (failure) {
      setError((failure as Error).message || 'Apple Calendar needs attention. Check the result before trying another change.')
      // Native ambiguity is never converted into a fresh write. The server timeout marks interrupted work uncertain.
    } finally { busy.current.delete(actionId) }
  }, [convex, installation, ready])
  useEffect(() => {
    if (!ready || !foreground || permission?.permission !== 'granted') return
    for (const item of pending ?? []) {
      const key = `${item.id}:${item.approvalId}:${item.revision}:${item.status}`
      if (busy.current.has(item.id) || checked.current.has(key)) continue
      checked.current.add(key)
      void run(item.id, item.status !== 'queued')
    }
  }, [pending, ready, foreground, permission?.permission, run, resume])
  return {
    state, error,
    connect: async () => { setError(''); const value = await nativeCalendar.connect(); setPermission({ ...value, available: true }); if (value.permission !== 'granted') throw new Error('Allow full Calendar access in iPhone Settings to save and verify events.') },
    select: async (id: string | null) => {
      if (!installation || !accounts) throw new Error('Wait for this iPhone connection to load.')
      if (!id) { if (local) await disconnect({ id: local.id as Id<'connections'> }); return }
      const status = await nativeCalendar.status(), calendar = status.calendars.find(c => c.id === id)
      setPermission({ ...status, available: true })
      if (status.permission !== 'granted' || !calendar) throw new Error('Choose a writable calendar on this iPhone.')
      const value = await register({ deviceId: installation, calendarId: id, title: calendar.title, account: calendar.account })
      await choose({ id: value.id, purpose: 'calendar', version: accounts.version })
    },
    reconcile: (id: string) => run(id, true),
    refresh: async (id: string) => {
      if (!installation) throw new Error('Open this calendar change on its original iPhone.')
      const args = { actionId: id as Id<'actions'>, deviceId: installation }, context = await convex.query(api.apple.refreshContext, args)
      if (context.payload.kind !== 'calendar') throw new Error('Choose a calendar event.')
      const event = await nativeCalendar.read({ eventId: context.eventId, calendarId: context.calendarId })
      if (event.eventId !== context.eventId || event.calendarId !== context.calendarId) throw new Error('The original Apple Calendar event identity changed. Review the original calendar before continuing.')
      await convex.action(api.apple.refresh, { ...args, revision: context.revision, payload: nativeEventPayload(event, context.payload), fingerprint: event.fingerprint })
    },
  }
}
