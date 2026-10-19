// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { event } from "../tests/fixtures/calendar";
import {
  microsoftEmailBody,
  microsoftEventBody,
  microsoftEventDraft,
  microsoftTransactionId,
  readMicrosoftCalendar,
  sameMicrosoftEvent,
  sendMicrosoftEmail,
  writeMicrosoftCalendar,
} from "./microsoftAdapter";
import { ReviewRequired, Unconfirmed } from "./googleAdapter";
const fetchMock = vi.fn();
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const empty = () => json({ value: [] });
const saved = (overrides = {}) => ({
  ...microsoftEventBody(event, "action", 1),
  id: "outlook-event",
  "@odata.etag": "version-2",
  webLink: "https://outlook.office.com/calendar/item/synthetic",
  ...overrides,
});
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());
describe("Microsoft calendar boundary", () => {
  it("creates with a stable transaction ID, no guests or reminders, then reads exact saved content", async () => {
    fetchMock
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(json({ id: "outlook-event" }, 201))
      .mockResolvedValueOnce(json(saved()));
    const dispatch = vi.fn(async () => true);
    expect(
      await writeMicrosoftCalendar(
        "token",
        "calendar/id",
        "action",
        1,
        event,
        undefined,
        dispatch,
      ),
    ).toMatchObject({ eventId: "outlook-event", etag: "version-2" });
    const [url, request] = fetchMock.mock.calls[1];
    expect(url).toBe(
      "https://graph.microsoft.com/v1.0/me/calendars/calendar%2Fid/events",
    );
    expect(JSON.parse(request.body)).toMatchObject({
      transactionId: microsoftTransactionId("action"),
      attendees: [],
      isReminderOn: false,
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(
      fetchMock.mock.calls.filter(([, request]) => request.method === "POST"),
    ).toHaveLength(1);
    expect(fetchMock.mock.calls[2][1].headers.Prefer).toContain("ImmutableId");
  });
  it("reconciles a timed-out create by its action marker without another POST", async () => {
    fetchMock
      .mockResolvedValueOnce(empty())
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(json({ value: [saved()] }));
    expect(
      await writeMicrosoftCalendar("token", "calendar", "action", 1, event),
    ).toMatchObject({ eventId: "outlook-event" });
    expect(
      fetchMock.mock.calls.filter(([, request]) => request.method === "POST"),
    ).toHaveLength(1);
    expect(decodeURIComponent(fetchMock.mock.calls[2][0])).toContain(
      "singleValueExtendedProperties",
    );
  });
  it("never reports completion when read-back is missing, mismatched, or unavailable", async () => {
    for (const response of [
      empty(),
      json({ ...saved(), subject: "Changed outside Daymark" }),
      new Response(null, { status: 503 }),
    ]) {
      fetchMock
        .mockReset()
        .mockResolvedValueOnce(empty())
        .mockResolvedValueOnce(json({ id: "outlook-event" }, 201))
        .mockResolvedValueOnce(response);
      await expect(
        writeMicrosoftCalendar("token", "calendar", "action", 1, event),
      ).rejects.toBeInstanceOf(Unconfirmed);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }
  });
  it("blocks mismatched duplicate and stale event versions before any write", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ value: [saved({ subject: "Different" })] }),
    );
    await expect(
      writeMicrosoftCalendar("token", "calendar", "action", 1, event),
    ).rejects.toBeInstanceOf(ReviewRequired);
    fetchMock.mockResolvedValueOnce(
      json(saved({ subject: "Different", "@odata.etag": "new-version" })),
    );
    await expect(
      writeMicrosoftCalendar("token", "calendar", "action", 1, event, {
        eventId: "outlook-event",
        etag: "reviewed-version",
      }),
    ).rejects.toThrow("changed");
    expect(fetchMock.mock.calls.every(([, request]) => !request.method)).toBe(
      true,
    );
  });
  it("reconciles an already matching result without dispatching another write", async () => {
    fetchMock.mockResolvedValueOnce(json({ value: [saved()] }));
    const dispatch = vi.fn(async () => true);
    expect(
      await writeMicrosoftCalendar(
        "token",
        "calendar",
        "action",
        1,
        event,
        undefined,
        dispatch,
      ),
    ).toMatchObject({ eventId: "outlook-event" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("updates with the reviewed ETag and turns concurrent rejection into new review", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(saved({ subject: "Old", "@odata.etag": "reviewed" })),
      )
      .mockResolvedValueOnce(new Response(null, { status: 412 }));
    await expect(
      writeMicrosoftCalendar("token", "calendar", "action", 1, event, {
        eventId: "outlook-event",
        etag: "reviewed",
      }),
    ).rejects.toBeInstanceOf(ReviewRequired);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "PATCH",
      headers: { "If-Match": "reviewed" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("requires approval at dispatch and will not modify meetings or recurring events", async () => {
    fetchMock.mockResolvedValueOnce(empty());
    expect(
      await writeMicrosoftCalendar(
        "token",
        "calendar",
        "action",
        1,
        event,
        undefined,
        async () => false,
      ),
    ).toBeNull();
    for (const change of [
      { attendees: [{}] },
      { recurrence: {} },
      { type: "seriesMaster" },
    ]) {
      fetchMock.mockResolvedValueOnce(
        json(saved({ ...change, "@odata.etag": "reviewed" })),
      );
      await expect(
        writeMicrosoftCalendar("token", "calendar", "action", 1, event, {
          eventId: "outlook-event",
          etag: "reviewed",
        }),
      ).rejects.toThrow("guests or repeats");
    }
    expect(fetchMock.mock.calls.every(([, request]) => !request.method)).toBe(
      true,
    );
  });
  it("verifies absence after removal and preserves uncertainty if read-back fails", async () => {
    fetchMock
      .mockResolvedValueOnce(json(saved({ "@odata.etag": "reviewed" })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(
      await writeMicrosoftCalendar(
        "token",
        "calendar",
        "action",
        1,
        { ...event, operation: "delete" },
        { eventId: "outlook-event", etag: "reviewed" },
      ),
    ).toMatchObject({ eventId: "outlook-event" });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "DELETE",
      headers: { "If-Match": "reviewed" },
    });
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(json(saved({ "@odata.etag": "reviewed" })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(
      writeMicrosoftCalendar(
        "token",
        "calendar",
        "action",
        1,
        { ...event, operation: "delete" },
        { eventId: "outlook-event", etag: "reviewed" },
      ),
    ).rejects.toBeInstanceOf(Unconfirmed);
  });
  it("keeps failed list reads and duplicate markers distinct from an absent event", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(
      readMicrosoftCalendar("token", "calendar", "action"),
    ).rejects.toMatchObject({ code: 404 });
    fetchMock.mockResolvedValueOnce(json({ value: [saved(), saved()] }));
    await expect(
      readMicrosoftCalendar("token", "calendar", "action"),
    ).rejects.toBeInstanceOf(ReviewRequired);
  });
  it("compares all-day UTC read-back across daylight-saving changes and refreshes local dates", () => {
    const allDay = {
      ...event,
      date: "2026-10-31",
      endDate: "2026-11-01",
      allDay: true,
      startTime: null,
      endTime: null,
    };
    const result = {
      ...microsoftEventBody(allDay, "action", 2),
      id: "id",
      "@odata.etag": "etag",
      start: { dateTime: "2026-10-31T07:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-11-02T08:00:00.0000000", timeZone: "UTC" },
    };
    expect(sameMicrosoftEvent(result, allDay, "action", 2)).toBe(true);
    expect(microsoftEventDraft(result, allDay)).toMatchObject({
      date: "2026-10-31",
      endDate: "2026-11-01",
      allDay: true,
      startTime: null,
      endTime: null,
    });
    expect(sameMicrosoftEvent(result, allDay, "action", 3)).toBe(false);
  });
});
const email = {
  kind: "email" as const,
  childId: "maya",
  to: "teacher@example.test",
  subject: "School reply",
  body: "Synthetic reply.",
  requirement: "",
  evidence: {},
};
describe("Microsoft send-only mail boundary", () => {
  it("records HTTP 202 as acceptance with a request ID, never inventing a message ID", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 202,
        headers: { "request-id": "provider-request" },
      }),
    );
    expect(await sendMicrosoftEmail("token", email, "action")).toEqual({
      accepted: true,
      requestId: "provider-request",
    });
    const [, request] = fetchMock.mock.calls[0];
    expect(JSON.parse(request.body)).toMatchObject({
      saveToSentItems: true,
      message: { toRecipients: [{ emailAddress: { address: email.to } }] },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("never retries a timeout or invents a successful receipt for an unexpected response", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    await expect(sendMicrosoftEmail("token", email, "action")).rejects.toThrow(
      "timeout",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValueOnce(json({ id: "not-a-send-receipt" }));
    await expect(
      sendMicrosoftEmail("token", email, "action"),
    ).rejects.toBeInstanceOf(Unconfirmed);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("sends only approved attachment bytes and blocks missing or oversized files before the request", () => {
    const withFile = {
      ...email,
      attachments: [{ id: "file", name: "notice.pdf", hash: "approved" }],
    };
    const files = [
      {
        name: "notice.pdf",
        mediaType: "application/pdf",
        data: new Uint8Array([1, 2, 3]),
      },
    ];
    expect(
      microsoftEmailBody(withFile, "action", files).message.attachments,
    ).toEqual([
      {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: "notice.pdf",
        contentType: "application/pdf",
        contentBytes: "AQID",
      },
    ]);
    expect(() => microsoftEmailBody(withFile, "action")).toThrow("missing");
    expect(() =>
      microsoftEmailBody(withFile, "action", [
        { ...files[0], data: new Uint8Array(3_000_000) },
      ]),
    ).toThrow("size limit");
    expect(() =>
      microsoftEmailBody(
        { ...email, to: "first@example.test\r\nBcc: hidden@example.test" },
        "action",
      ),
    ).toThrow("headers");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
it("preserves reminders and unrelated properties when updating an explicitly imported external event", async () => {
  const prior = saved({
    subject: "Old",
    isReminderOn: true,
    "@odata.etag": "reviewed",
    singleValueExtendedProperties: [
      { id: "Other app property", value: "keep" },
    ],
  });
  fetchMock
    .mockResolvedValueOnce(json(prior))
    .mockResolvedValueOnce(json({ id: "outlook-event" }))
    .mockResolvedValueOnce(json(saved()));
  await writeMicrosoftCalendar("token", "calendar", "action", 1, event, {
    eventId: "outlook-event",
    etag: "reviewed",
    external: true,
  });
  const request = JSON.parse(fetchMock.mock.calls[1][1].body);
  expect(request).not.toHaveProperty("isReminderOn");
  expect(request.singleValueExtendedProperties).toContainEqual({
    id: "Other app property",
    value: "keep",
  });
  expect(fetchMock.mock.calls[1][1].headers["If-Match"]).toBe("reviewed");
});
