import { useEffect, useState } from 'react'
import { calendarWindow } from '../../../shared/calendarAwareness'

/** Match the provider feed's household-local dates and refresh after local midnight or app resume. */
export function useCalendarWindow(timezone: string) {
  const [anchor, setAnchor] = useState(() => Date.now())
  useEffect(() => {
    const refresh = () => setAnchor(previous => {
      const now = Date.now(), before = calendarWindow(previous, timezone), after = calendarWindow(now, timezone)
      return before.from === after.from && before.through === after.through ? previous : now
    })
    refresh()
    const timer = setInterval(refresh, 30000)
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [timezone])
  return calendarWindow(anchor, timezone)
}
