// @vitest-environment node
import { expect, it, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@googleapis/calendar", () => ({
  calendar: () => ({ events: { list: mocks.list } }),
}));
import { readGoogleCalendarPage } from "./calendarReading";
beforeEach(() => mocks.list.mockReset());
it("accepts an empty Google response without claiming an error and never loads another page automatically", async () => {
  mocks.list.mockResolvedValue({ data: { nextPageToken: "page2" } });
  const page = await readGoogleCalendarPage(
    {} as any,
    { id: "family", name: "Family", timezone: "UTC" },
    0,
    86400_000,
  );
  expect(page).toEqual({ events: [], omitted: 0, next: "page2" });
  expect(mocks.list).toHaveBeenCalledTimes(1);
  expect(mocks.list.mock.calls[0][0]).toMatchObject({
    maxResults: 100,
    singleEvents: true,
    showDeleted: false,
  });
});
it("rejects malformed provider pages and marks bad individual events omitted", async () => {
  mocks.list.mockResolvedValueOnce({ data: { items: "invalid" } });
  await expect(
    readGoogleCalendarPage(
      {} as any,
      { id: "family", name: "Family", timezone: "UTC" },
      0,
      86400_000,
    ),
  ).rejects.toThrow("invalid page");
  mocks.list.mockResolvedValueOnce({
    data: { items: [{ id: "bad" }, { id: "cancelled", status: "cancelled" }] },
  });
  expect(
    await readGoogleCalendarPage(
      {} as any,
      { id: "family", name: "Family", timezone: "UTC" },
      0,
      86400_000,
    ),
  ).toEqual({ events: [], omitted: 1 });
});
