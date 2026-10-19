import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
export const googleCalendarReadScope =
  "https://www.googleapis.com/auth/calendar.readonly";
export const microsoftCalendarReadScope = "Calendars.Read";
export const calendarLimits = {
  calendars: 5,
  page: 100,
  pages: 30,
  events: 3000,
  leaseMs: 90_000,
  refreshMs: 15 * 60_000,
  freshnessMs: 30 * 60_000,
  retentionMs: 2 * 86400_000,
};
export const calendarSelectionSchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(1024),
        name: z.string().min(1).max(200),
        timezone: z.string().min(1).max(100).refine(validTimezone),
      })
      .strict(),
  )
  .min(1)
  .max(calendarLimits.calendars)
  .refine(
    (items) => new Set(items.map((i) => i.id)).size === items.length,
    "Select each calendar once.",
  );
export const calendarEventSchema = z
  .object({
    providerId: z.string().min(1).max(2048),
    calendarId: z.string().min(1).max(1024),
    title: z.string().max(500),
    location: z.string().max(1000),
    start: z.number().finite(),
    end: z.number().finite(),
    allDay: z.boolean(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    timezone: z.string().max(100),
    busy: z.boolean(),
    recurring: z.boolean(),
    uid: z.string().max(2048).optional(),
    url: z.string().max(2048).optional(),
    etag: z.string().max(2048).optional(),
  })
  .strict()
  .refine((e) => e.end > e.start, "Event end must follow its start.");
export type CalendarEvent = z.infer<typeof calendarEventSchema>;
export type CalendarSelection = z.infer<typeof calendarSelectionSchema>[number];
export function validTimezone(zone: string) {
  try {
    Temporal.Now.zonedDateTimeISO(zone);
    return true;
  } catch {
    return false;
  }
}
export function calendarReadAllowed(c: {
  status: string;
  provider?: string;
  scopes: string[];
}) {
  return (
    c.status === "active" &&
    (c.provider === "microsoft"
      ? c.scopes.some((scope) =>
          [
            microsoftCalendarReadScope.toLowerCase(),
            "calendars.readwrite",
          ].includes(scope.toLowerCase()),
        )
      : c.provider !== "apple" && c.scopes.includes(googleCalendarReadScope))
  );
}
export function calendarWindow(now: number, timezone: string) {
  const day = Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(timezone)
    .toPlainDate();
  return {
    from: day.subtract({ days: 7 }).toZonedDateTime(timezone).epochMilliseconds,
    through: day.add({ days: 90 }).toZonedDateTime(timezone).epochMilliseconds,
  };
}
export function eventInstant(value: string, zone: string, allDay = false) {
  if (allDay)
    return Temporal.PlainDate.from(value).toZonedDateTime(zone)
      .epochMilliseconds;
  try {
    return Temporal.Instant.from(value).epochMilliseconds;
  } catch {
    return Temporal.PlainDateTime.from(value).toZonedDateTime(zone, {
      disambiguation: "reject",
    }).epochMilliseconds;
  }
}
export function findCalendarConflicts(
  events: CalendarEvent[],
  start: number,
  end: number,
  ignoreUid?: string,
) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw new Error("Choose a valid time range.");
  const seen = new Set<string>();
  return events
    .filter((e) => {
      if (
        !e.busy ||
        e.start >= end ||
        e.end <= start ||
        (ignoreUid && e.uid === ignoreUid)
      )
        return false;
      const key = JSON.stringify([
        e.uid || `${e.calendarId}:${e.providerId}`,
        e.start,
        e.end,
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.start - b.start);
}
export function safeCalendarUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}
