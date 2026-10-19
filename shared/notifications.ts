import { Temporal } from '@js-temporal/polyfill'
export function nextNotificationTime(now: number, timezone: string, start = '20:00', end = '07:00') {
  const at = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timezone)
  const time = at.toPlainTime().toString().slice(0, 5)
  const quiet = start === end ? false : start > end ? time >= start || time < end : time >= start && time < end
  if (!quiet) return now
  const day = start > end && time >= start ? at.toPlainDate().add({ days: 1 }) : at.toPlainDate()
  return Temporal.ZonedDateTime.from(`${day}T${end}:00[${timezone}]`, { disambiguation: 'compatible' }).epochMilliseconds
}
