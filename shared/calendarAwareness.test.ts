import { describe, expect, it } from "vitest";
import {
  calendarReadAllowed,
  calendarSelectionSchema,
  calendarWindow,
  eventInstant,
  findCalendarConflicts,
  type CalendarEvent,
} from "./calendarAwareness.js";
const event: CalendarEvent = {
  providerId: "one",
  calendarId: "school",
  title: "Trip",
  location: "",
  start: 100,
  end: 200,
  allDay: false,
  timezone: "UTC",
  busy: true,
  recurring: false,
  uid: "same",
};
describe("private calendar rules", () => {
  it("requires a distinct reading grant and live connection", () => {
    expect(
      calendarReadAllowed({
        status: "active",
        scopes: ["https://www.googleapis.com/auth/calendar.app.created"],
      }),
    ).toBe(false);
    expect(
      calendarReadAllowed({
        status: "active",
        provider: "microsoft",
        scopes: ["Calendars.Read"],
      }),
    ).toBe(true);
    expect(
      calendarReadAllowed({
        status: "revoked",
        provider: "microsoft",
        scopes: ["Calendars.ReadWrite"],
      }),
    ).toBe(false);
  });
  it("bounds unique selected calendars and checks timezone", () => {
    expect(
      calendarSelectionSchema.safeParse([
        { id: "a", name: "A", timezone: "Moon" },
      ]).success,
    ).toBe(false);
    expect(
      calendarSelectionSchema.safeParse(
        Array.from({ length: 2 }, () => ({
          id: "a",
          name: "A",
          timezone: "UTC",
        })),
      ).success,
    ).toBe(false);
  });
  it("uses local days over daylight saving and exclusive all-day end", () => {
    expect(eventInstant("2026-11-01", "America/Los_Angeles", true)).toBe(
      Date.parse("2026-11-01T07:00:00Z"),
    );
    expect(
      eventInstant("2026-11-02", "America/Los_Angeles", true) -
        eventInstant("2026-11-01", "America/Los_Angeles", true),
    ).toBe(25 * 3600_000);
    const w = calendarWindow(
      Date.parse("2026-11-01T12:00Z"),
      "America/Los_Angeles",
    );
    expect(w.from).toBe(Date.parse("2026-10-25T07:00Z"));
  });
  it.each([
    ['America/Los_Angeles', '2026-10-19T01:00:00Z', '2026-10-11T07:00:00Z', '2027-01-16T08:00:00Z'],
    ['Asia/Tokyo', '2026-10-18T20:00:00Z', '2026-10-11T15:00:00Z', '2027-01-16T15:00:00Z'],
    ['America/Los_Angeles', '2026-03-08T20:00:00Z', '2026-03-01T08:00:00Z', '2026-06-06T07:00:00Z'],
  ])('keeps %s feed and agenda bounds on matching local midnights', (zone, now, from, through) => {
    expect(calendarWindow(Date.parse(now), zone)).toEqual({ from: Date.parse(from), through: Date.parse(through) })
    expect(calendarWindow(Date.parse(now) + 60000, zone)).toEqual(calendarWindow(Date.parse(now), zone))
  });
  it("does not claim an adjacent event conflicts and deduplicates shared calendar representations", () => {
    expect(
      findCalendarConflicts(
        [event, { ...event, calendarId: "copy", providerId: "two" }],
        150,
        210,
      ),
    ).toHaveLength(1);
    expect(findCalendarConflicts([event], 200, 210)).toHaveLength(0);
    expect(
      findCalendarConflicts([{ ...event, busy: false }], 150, 160),
    ).toEqual([]);
    expect(findCalendarConflicts([event], 150, 160, "same")).toEqual([]);
  });
  it("rejects ambiguous local times instead of choosing an occurrence", () => {
    expect(() =>
      eventInstant("2026-11-01T01:30:00", "America/Los_Angeles"),
    ).toThrow();
    expect(
      eventInstant("2026-11-01T01:30:00-08:00", "America/Los_Angeles"),
    ).toBe(Date.parse("2026-11-01T09:30Z"));
  });
});
