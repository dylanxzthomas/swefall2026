import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'
const crons = cronJobs()
crons.interval('Refresh private calendar snapshots', { minutes: 5 }, internal.calendarFeeds.poll, {})
crons.interval('Check private Gmail mailboxes', { minutes: 5 }, internal.mailbox.poll, {})
crons.interval('Check permitted email watches', { minutes: 5 }, internal.emailWatches.poll, {})
crons.interval('Recover missed routine preparation', { minutes: 5 }, internal.routines.recover, {})
crons.interval('Remove interrupted private file copies', { hours: 1 }, internal.privacy.cleanupStorage, {})
crons.interval('Expire private sources', { hours: 1 }, internal.privacy.expireSources, {})
crons.interval('Retry account identity deletion', { hours: 1 }, internal.privacy.retryIdentities, {})
export default crons
