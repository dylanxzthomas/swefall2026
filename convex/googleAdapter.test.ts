// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eventBody } from "../shared/daymark";
import { event } from "../tests/fixtures/calendar";
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  insert: vi.fn(),
  patch: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@googleapis/calendar", () => ({
  calendar: () => ({ events: mocks }),
}));
vi.mock("@googleapis/gmail", () => ({
  gmail: () => ({ users: { messages: { send: mocks.send } } }),
}));
import { emailRaw, sendEmail, writeCalendar } from "./googleAdapter";
const rejected = (status: number) => ({ response: { status } });
beforeEach(() => vi.resetAllMocks());
describe("direct Google boundary", () => {
  it("inserts stable event ID with notifications suppressed, then verifies read-back", async () => {
    const expected = {
      ...eventBody(event, "action", 1),
      id: "provider",
      etag: "etag",
    };
    mocks.get
      .mockRejectedValueOnce(rejected(404))
      .mockResolvedValueOnce({ data: expected });
    mocks.insert.mockResolvedValue({ data: { id: "provider" } });
    const dispatch = vi.fn(async () => true);
    expect(
      await writeCalendar(
        {} as any,
        "calendar",
        "action",
        1,
        event,
        undefined,
        dispatch,
      ),
    ).toMatchObject({ etag: "etag" });
    expect(mocks.insert.mock.calls[0][0]).toMatchObject({
      calendarId: "calendar",
      sendUpdates: "none",
      requestBody: { id: expect.stringMatching(/^d[0-9a-f]{64}$/) },
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
  it("reconciles a transport timeout without inserting twice", async () => {
    mocks.get
      .mockRejectedValueOnce(rejected(404))
      .mockResolvedValueOnce({
        data: { ...eventBody(event, "action", 1), etag: "etag" },
      });
    mocks.insert.mockRejectedValue(new Error("timeout"));
    expect(
      await writeCalendar({} as any, "calendar", "action", 1, event),
    ).toMatchObject({ etag: "etag" });
    expect(mocks.insert).toHaveBeenCalledOnce();
  });
  it("never presents accepted but mismatched read-back as completed", async () => {
    mocks.get
      .mockRejectedValueOnce(rejected(404))
      .mockResolvedValueOnce({
        data: {
          ...eventBody(event, "action", 1),
          summary: "Changed externally",
        },
      });
    mocks.insert.mockResolvedValue({ data: { id: "provider" } });
    await expect(
      writeCalendar({} as any, "calendar", "action", 1, event),
    ).rejects.toThrow("could not be verified");
  });
  it("refuses stale ETags before writing and uses If-Match for updates", async () => {
    mocks.get.mockResolvedValueOnce({ data: { etag: "new-etag" } });
    await expect(
      writeCalendar({} as any, "calendar", "action", 1, event, {
        eventId: "old",
        etag: "old-etag",
      }),
    ).rejects.toThrow("changed");
    expect(mocks.patch).not.toHaveBeenCalled();
    mocks.get
      .mockResolvedValueOnce({ data: { etag: "old-etag" } })
      .mockResolvedValueOnce({
        data: { ...eventBody(event, "action", 1), etag: "verified" },
      });
    mocks.patch.mockResolvedValue({});
    await writeCalendar({} as any, "calendar", "action", 1, event, {
      eventId: "old",
      etag: "old-etag",
    });
    expect(mocks.patch.mock.calls[0][1].headers).toEqual({
      "If-Match": "old-etag",
    });
  });
  it("checks revocation immediately before dispatch", async () => {
    mocks.get.mockRejectedValue(rejected(404));
    expect(
      await writeCalendar(
        {} as any,
        "calendar",
        "action",
        1,
        event,
        undefined,
        async () => false,
      ),
    ).toBeNull();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("sends exactly one Gmail request with retries disabled and no inferred thread", async () => {
    const p = {
      kind: "email" as const,
      childId: "maya",
      to: "teacher@example.test",
      subject: "Maya’s absence",
      body: "Maya will be absent.",
      evidence: {},
      requirement: "",
    };
    mocks.send.mockRejectedValue(new Error("ambiguous timeout"));
    await expect(sendEmail({} as any, p, "email-action")).rejects.toThrow(
      "timeout",
    );
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send.mock.calls[0][1].retry).toBe(false);
    expect(mocks.send.mock.calls[0][0].requestBody.threadId).toBeUndefined();
    expect(Buffer.from(emailRaw(p, "id"), "base64url").toString()).toContain(
      "To: teacher@example.test",
    );
    expect(() =>
      emailRaw({ ...p, to: "a@example.test\r\nBcc: other@example.test" }, "id"),
    ).toThrow();
  });
});
it("MIME includes only approved bytes and safely folds Unicode subjects and filenames", () => {
  const p = {
    kind: "email" as const,
    childId: "maya",
    to: "teacher@example.test",
    subject: "学校 ".repeat(45),
    body: "See attachment",
    requirement: "",
    evidence: {},
    attachments: [
      { id: "file", name: "学校\r\nX-Evil: x.pdf", hash: "fingerprint" },
    ],
  };
  const mime = Buffer.from(
    emailRaw(p, "synthetic", [
      {
        name: p.attachments[0].name,
        mediaType: "application/pdf",
        data: new TextEncoder().encode("synthetic bytes"),
      },
    ]),
    "base64url",
  ).toString();
  expect(mime).toContain("multipart/mixed");
  expect(mime).toContain(Buffer.from("synthetic bytes").toString("base64"));
  expect(mime).not.toContain("\r\nX-Evil:");
  expect(
    mime
      .split("\r\n")
      .filter((line) => line.startsWith("Subject:") || line.startsWith(" =?"))
      .every((line) => line.length < 80),
  ).toBe(true);
  expect(() => emailRaw(p, "synthetic")).toThrow("missing");
});
it("requires the reviewed ETag before removal and verifies that Google no longer has the event", async () => {
  const { deleteCalendar } = await import("./googleAdapter");
  const remove = vi.fn().mockResolvedValue({});
  (mocks as any).delete = remove;
  mocks.get.mockResolvedValueOnce({ data: { etag: "changed" } });
  await expect(
    deleteCalendar({} as any, "calendar", {
      eventId: "existing",
      etag: "reviewed",
    }),
  ).rejects.toThrow("changed");
  expect(remove).not.toHaveBeenCalled();
  mocks.get
    .mockResolvedValueOnce({ data: { etag: "reviewed" } })
    .mockRejectedValueOnce(rejected(404));
  expect(
    await deleteCalendar(
      {} as any,
      "calendar",
      { eventId: "existing", etag: "reviewed" },
      async () => true,
    ),
  ).toMatchObject({ eventId: "existing" });
  expect(remove.mock.calls[0][1].headers).toEqual({ "If-Match": "reviewed" });
});
it("preserves reminders and unrelated private metadata when changing an explicitly imported individual event", async () => {
  const before = {
      eventId: "external-event",
      etag: "original",
      external: true,
    },
    current = {
      id: "external-event",
      etag: "original",
      summary: "Original",
      reminders: { useDefault: true },
      extendedProperties: { private: { otherApp: "keep" } },
    };
  mocks.get
    .mockResolvedValueOnce({ data: current })
    .mockResolvedValueOnce({
      data: { ...eventBody(event, "action", 1), etag: "after" },
    });
  mocks.patch.mockResolvedValue({});
  await writeCalendar({} as any, "calendar", "action", 1, event, before);
  const patch = mocks.patch.mock.calls[0][0].requestBody;
  expect(patch).not.toHaveProperty("reminders");
  expect(patch.extendedProperties.private.otherApp).toBe("keep");
  expect(mocks.patch.mock.calls[0][1].headers["If-Match"]).toBe("original");
});
it("rejects guests, recurrence and special event settings before any update dispatch", async () => {
  for (const change of [
    { attendees: [{ email: "guest@example.test" }] },
    { recurrence: ["RRULE:FREQ=WEEKLY"] },
    { recurringEventId: "series" },
    { eventType: "outOfOffice" },
    { conferenceData: { conferenceId: "meeting" } },
  ]) {
    mocks.get.mockResolvedValueOnce({ data: { etag: "original", ...change } });
    const dispatch = vi.fn(async () => true);
    await expect(
      writeCalendar(
        {} as any,
        "calendar",
        "action",
        1,
        event,
        { eventId: "existing", etag: "original", external: true },
        dispatch,
      ),
    ).rejects.toThrow("directly");
    expect(dispatch).not.toHaveBeenCalled();
  }
  expect(mocks.patch).not.toHaveBeenCalled();
});
