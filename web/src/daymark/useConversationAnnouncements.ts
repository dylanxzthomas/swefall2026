import { useEffect, useRef, useState } from 'react'
import type { ConversationUpdate } from './conversation'

/** Announce genuinely arriving receipts, not a historical backfill or a new account's history. */
export function useConversationAnnouncements(updates: ConversationUpdate[], owner: string) {
  const previous = useRef({ owner, since: Date.now(), ids: new Set(updates.map(update => update.id)) })
  const [announcement, setAnnouncement] = useState<{ owner: string; ids: string[] }>({ owner, ids: [] })
  useEffect(() => {
    if (previous.current.owner !== owner) {
      previous.current = { owner, since: Date.now(), ids: new Set(updates.map(update => update.id)) }
      setAnnouncement({ owner, ids: [] }); return
    }
    const fresh = updates.filter(update => !previous.current.ids.has(update.id) && update.at >= previous.current.since)
    previous.current.ids = new Set(updates.map(update => update.id))
    if (fresh.length) setAnnouncement({ owner, ids: fresh.slice(-3).map(update => update.id) })
  }, [updates, owner])
  return announcement.owner === owner ? updates.filter(update => announcement.ids.includes(update.id)).map(update => update.text).join(' ') : ''
}
