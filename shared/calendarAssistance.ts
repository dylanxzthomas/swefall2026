import { sourceHash } from "./daymark.js";
import type { CalendarEvent } from "./calendarAwareness.js";
export const calendarAssistanceLimits = {
  changes: 10,
  debounceMs: 30_000,
  text: 4000,
} as const;
export type CalendarChange = {
  key: string;
  before?: CalendarEvent;
  after?: CalendarEvent;
};
/** Only fields actually read are compared. ETags and unrelated metadata do not create work. */
export function calendarMeaning(event: CalendarEvent) {
  return {
    title: event.title,
    location: event.location,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    timezone: event.timezone,
    busy: event.busy,
  };
}
export const sameCalendarMeaning = (a?: CalendarEvent, b?: CalendarEvent) =>
  a && b
    ? JSON.stringify(calendarMeaning(a)) === JSON.stringify(calendarMeaning(b))
    : !a && !b;
export const calendarIdentity = (event: CalendarEvent) =>
  sourceHash(JSON.stringify([event.calendarId, event.providerId]));
export function calendarChanges(
  before: CalendarEvent[],
  after: CalendarEvent[],
  oldWindow: { from: number; through: number },
  newWindow: { from: number; through: number },
) {
  const old = new Map(before.map((e) => [calendarIdentity(e), e])),
    next = new Map(after.map((e) => [calendarIdentity(e), e])),
    changes: CalendarChange[] = [];
  for (const [key, event] of old) {
    const current = next.get(key);
    if (sameCalendarMeaning(event, current)) continue;
    if (
      !current &&
      (event.end <= newWindow.from || event.start >= newWindow.through)
    )
      continue;
    changes.push({
      key,
      before: event,
      ...(current ? { after: current } : {}),
    });
  }
  for (const [key, event] of next)
    if (
      !old.has(key) &&
      event.end > oldWindow.from &&
      event.start < oldWindow.through
    )
      changes.push({ key, after: event });
  return changes.sort(
    (a, b) =>
      (a.after?.start ?? a.before!.start) - (b.after?.start ?? b.before!.start),
  );
}
export function mergeCalendarChanges(
  previous: CalendarChange[],
  latest: CalendarChange[],
) {
  const merged = new Map(previous.map((c) => [c.key, c]));
  for (const change of latest) {
    const old = merged.get(change.key);
    const next: CalendarChange = old
      ? {
          key: change.key,
          ...(old.before ? { before: old.before } : {}),
          ...(change.after ? { after: change.after } : {}),
        }
      : change;
    if (sameCalendarMeaning(next.before, next.after)) merged.delete(change.key);
    else merged.set(change.key, next);
  }
  return [...merged.values()];
}
export function calendarChangeEvidence(change: CalendarChange) {
  return JSON.stringify({
    change: change.before ? (change.after ? "updated" : "removed") : "added",
    ...(change.before ? { before: calendarMeaning(change.before) } : {}),
    ...(change.after ? { after: calendarMeaning(change.after) } : {}),
  });
}
