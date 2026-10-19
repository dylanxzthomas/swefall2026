import { expect, it } from "vitest";
import {
  calendarChanges,
  mergeCalendarChanges,
  calendarChangeEvidence,
} from "./calendarAssistance.js";
import type { CalendarEvent } from "./calendarAwareness.js";
const event: CalendarEvent = {
    providerId: "school",
    calendarId: "primary",
    title: "Trip",
    location: "School",
    start: 100,
    end: 200,
    allDay: false,
    timezone: "UTC",
    busy: true,
    recurring: false,
  },
  window = { from: 0, through: 1000 };
it("ignores provider version churn and window rollover while distinguishing meaningful updates and removals", () => {
  expect(
    calendarChanges(
      [event],
      [{ ...event, etag: "new", url: "https://calendar.example.test" }],
      window,
      window,
    ),
  ).toEqual([]);
  expect(
    calendarChanges(
      [event],
      [{ ...event, start: 150, end: 250 }],
      window,
      window,
    )[0],
  ).toMatchObject({ before: { start: 100 }, after: { start: 150 } });
  expect(
    calendarChanges([event], [], window, { from: 200, through: 1200 }),
  ).toEqual([]);
  expect(
    calendarChanges([], [{ ...event, start: 1100, end: 1150 }], window, {
      from: 200,
      through: 1200,
    }),
  ).toEqual([]);
  expect(calendarChanges([event], [], window, window)).toHaveLength(1);
});
it("coalesces earliest before and latest after, drops undone changes and emits only actually observed fields", () => {
  const first = calendarChanges(
      [event],
      [{ ...event, title: "Museum trip" }],
      window,
      window,
    ),
    second = calendarChanges(
      [{ ...event, title: "Museum trip" }],
      [{ ...event, title: "New museum" }],
      window,
      window,
    ),
    merged = mergeCalendarChanges(first, second);
  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({
    before: { title: "Trip" },
    after: { title: "New museum" },
  });
  const undo = calendarChanges(
    [{ ...event, title: "New museum" }],
    [event],
    window,
    window,
  );
  expect(mergeCalendarChanges(merged, undo)).toEqual([]);
  expect(calendarChangeEvidence(first[0])).not.toContain("providerId");
  expect(calendarChangeEvidence(first[0])).toContain("Museum trip");
});
