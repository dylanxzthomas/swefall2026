import { afterEach, expect, it, vi } from "vitest";
import {
  graphCalendarPagePath,
  normalizeCalendarEvent,
  readMicrosoftCalendarPage,
} from "./calendarReading";
const selected = {
  id: "family/one",
  name: "Family",
  timezone: "America/Los_Angeles",
};
afterEach(() => vi.unstubAllGlobals());
it("normalizes expanded Google recurrence exceptions, all-day dates and declines without treating cancellations as events", () => {
  const raw = {
    id: "occurrence",
    summary: "Trip",
    start: { date: "2026-11-01" },
    end: { date: "2026-11-02" },
    recurringEventId: "series",
    iCalUID: "shared",
  };
  expect(normalizeCalendarEvent("google", raw, selected)).toMatchObject({
    start: Date.parse("2026-11-01T07:00Z"),
    end: Date.parse("2026-11-02T08:00Z"),
    allDay: true,
    recurring: true,
  });
  expect(
    normalizeCalendarEvent("google", { ...raw, status: "cancelled" }, selected),
  ).toBeNull();
  expect(
    normalizeCalendarEvent(
      "google",
      { ...raw, attendees: [{ self: true, responseStatus: "declined" }] },
      selected,
    )?.busy,
  ).toBe(false);
});
it("normalizes Microsoft UTC offsets and rejects missing or ambiguous dates", () => {
  const raw = {
    id: "one",
    subject: "Dinner",
    start: { dateTime: "2026-11-01T09:30:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-11-01T10:30:00", timeZone: "UTC" },
    showAs: "busy",
    type: "exception",
  };
  expect(normalizeCalendarEvent("microsoft", raw, selected)).toMatchObject({
    start: Date.parse("2026-11-01T09:30Z"),
    recurring: true,
    busy: true,
  });
  expect(() =>
    normalizeCalendarEvent("microsoft", { ...raw, end: undefined }, selected),
  ).toThrow();
  expect(
    normalizeCalendarEvent(
      "microsoft",
      { ...raw, isCancelled: true },
      selected,
    ),
  ).toBeNull();
});
it("rejects cross-origin, cross-calendar, credentialed and unexpected Graph next links", () => {
  for (const next of [
    "https://attacker.test/v1.0/me/calendars/family%2Fone/calendarView",
    "https://graph.microsoft.com/v1.0/me/messages",
    "https://secret@graph.microsoft.com/v1.0/me/calendars/family%2Fone/calendarView",
    "https://graph.microsoft.com/v1.0/me/calendars/another/calendarView",
  ])
    expect(() => graphCalendarPagePath(selected.id, next, 0, 1000)).toThrow();
  expect(
    graphCalendarPagePath(
      selected.id,
      "https://graph.microsoft.com/v1.0/me/calendars/family%2Fone/calendarView?$skiptoken=abc",
      0,
      1000,
    ),
  ).toContain("$skiptoken=abc");
});
it("reads one bounded Graph page without following cursors automatically and marks malformed events incomplete", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          value: [
            { id: "bad" },
            {
              id: "good",
              subject: "Trip",
              start: { dateTime: "2026-10-14T12:00:00", timeZone: "UTC" },
              end: { dateTime: "2026-10-14T13:00:00", timeZone: "UTC" },
              showAs: "busy",
            },
          ],
          "@odata.nextLink":
            "https://graph.microsoft.com/v1.0/me/calendars/family%2Fone/calendarView?$skiptoken=abc",
        }),
        { status: 200 },
      ),
    );
  vi.stubGlobal("fetch", fetch);
  const page = await readMicrosoftCalendarPage(
    "synthetic-token",
    selected,
    Date.parse("2026-10-14T00:00Z"),
    Date.parse("2026-10-15T00:00Z"),
  );
  expect(page.events).toHaveLength(1);
  expect(page.omitted).toBe(1);
  expect(page.next).toContain("skiptoken");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(new URL(fetch.mock.calls[0][0]).searchParams.get("$top")).toBe("100");
});
