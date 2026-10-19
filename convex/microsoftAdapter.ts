"use node";
import { Temporal } from "@js-temporal/polyfill";
import {
  calendarTimes,
  hash,
  type CalendarDraft,
  type EmailDraft,
} from "../shared/daymark";
import {
  ReviewRequired,
  Unconfirmed,
  providerCode,
  type EmailFile,
} from "./googleAdapter";

const graphOrigin = "https://graph.microsoft.com/v1.0";
// Fixed property names avoid creating a new MAPI named property for every action.
export const actionProperty =
  "String {a8ab2a0c-b54d-4b51-86fb-1379fb1b167e} Name DaymarkAction";
export const revisionProperty =
  "String {a8ab2a0c-b54d-4b51-86fb-1379fb1b167e} Name DaymarkRevision";
const expand = `singleValueExtendedProperties($filter=id eq '${actionProperty}' or id eq '${revisionProperty}')`;
export type MicrosoftCalendarReceipt = {
  eventId: string;
  etag: string;
  url?: string;
};
export type MicrosoftEvent = {
  id?: string;
  "@odata.etag"?: string;
  subject?: string;
  webLink?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  body?: { contentType?: string; content?: string };
  location?: { displayName?: string };
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isOrganizer?: boolean;
  isOnlineMeeting?: boolean;
  onlineMeeting?: unknown;
  hasAttachments?: boolean;
  attendees?: unknown[];
  recurrence?: unknown;
  type?: string;
  singleValueExtendedProperties?: { id: string; value: string }[];
};
export class MicrosoftError extends Error {
  constructor(public code: number) {
    super(`Microsoft request failed (${code}).`);
  }
}
export async function microsoftRequest<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<{ data: T; response: Response }> {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error("Invalid Microsoft API path.");
  const response = await fetch(`${graphOrigin}${path}`, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(25_000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      Prefer:
        'IdType="ImmutableId", outlook.body-content-type="text", outlook.timezone="UTC"',
      ...init.headers,
    },
  });
  if (!response.ok) throw new MicrosoftError(response.status);
  const data =
    response.status === 202 || response.status === 204
      ? undefined
      : await response.json();
  return { data: data as T, response };
}
const basePath = (calendarId: string) =>
  `/me/calendars/${encodeURIComponent(calendarId)}/events`;
const metadata = (event: MicrosoftEvent, id: string) =>
  event.singleValueExtendedProperties?.find((p) => p.id === id)?.value;
export const microsoftTransactionId = (actionId: string) => {
  const value = hash(actionId);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
};
export function microsoftEventBody(
  payload: CalendarDraft,
  actionId: string,
  revision: number,
) {
  const times = calendarTimes(payload);
  return {
    subject: payload.title,
    body: { contentType: "text", content: payload.notes },
    location: { displayName: payload.location },
    isAllDay: payload.allDay,
    isReminderOn: false,
    attendees: [],
    start:
      "date" in times.start
        ? {
            dateTime: `${times.start.date}T00:00:00`,
            timeZone: payload.timezone,
          }
        : { dateTime: times.start.dateTime.replace(/Z$/, ""), timeZone: "UTC" },
    end:
      "date" in times.end
        ? { dateTime: `${times.end.date}T00:00:00`, timeZone: payload.timezone }
        : { dateTime: times.end.dateTime.replace(/Z$/, ""), timeZone: "UTC" },
    singleValueExtendedProperties: [
      { id: actionProperty, value: actionId },
      { id: revisionProperty, value: String(revision) },
    ],
  };
}
function graphInstant(time: MicrosoftEvent["start"]) {
  if (!time?.dateTime) throw new Error("Calendar date is missing.");
  // Reads ask Graph for UTC, while direct test fixtures may retain a supported IANA zone.
  const local = Temporal.PlainDateTime.from(time.dateTime);
  return local
    .toZonedDateTime(
      time.timeZone === "UTC" ? "UTC" : (time.timeZone ?? "UTC"),
      { disambiguation: "reject" },
    )
    .toInstant();
}
export function sameMicrosoftEvent(
  event: MicrosoftEvent,
  payload: CalendarDraft,
  actionId: string,
  revision: number,
) {
  try {
    const expected = microsoftEventBody(payload, actionId, revision);
    if (
      event.isCancelled ||
      (event.attendees?.length ?? 0) > 0 ||
      event.recurrence ||
      (event.type && event.type !== "singleInstance")
    )
      return false;
    if (
      event.subject !== expected.subject ||
      (event.body?.content ?? "") !== expected.body.content ||
      (event.body?.contentType ?? "text").toLowerCase() !== "text" ||
      (event.location?.displayName ?? "") !== expected.location.displayName ||
      Boolean(event.isAllDay) !== payload.allDay
    )
      return false;
    if (
      metadata(event, actionProperty) !== actionId ||
      metadata(event, revisionProperty) !== String(revision)
    )
      return false;
    // Graph's UTC preference can shift midnight dates. Compare instants for both timed and all-day events.
    return (
      Temporal.Instant.compare(
        graphInstant(event.start),
        graphInstant(expected.start),
      ) === 0 &&
      Temporal.Instant.compare(
        graphInstant(event.end),
        graphInstant(expected.end),
      ) === 0
    );
  } catch {
    return false;
  }
}
export async function readMicrosoftCalendar(
  token: string,
  calendarId: string,
  actionId: string,
  before?: { eventId: string },
): Promise<MicrosoftEvent | null> {
  const base = basePath(calendarId);
  if (before) {
    try {
      return (
        await microsoftRequest<MicrosoftEvent>(
          token,
          `${base}/${encodeURIComponent(before.eventId)}?${new URLSearchParams({ $expand: expand })}`,
        )
      ).data;
    } catch (error) {
      if (providerCode(error) === 404 || providerCode(error) === 410)
        return null;
      throw error;
    }
  }
  // The provider-generated event ID may be lost after an interrupted POST. The action property remains queryable.
  const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${actionProperty}' and ep/value eq '${actionId.replace(/'/g, "''")}')`;
  const { data } = await microsoftRequest<{
    value?: MicrosoftEvent[];
    "@odata.nextLink"?: string;
  }>(
    token,
    `${base}?${new URLSearchParams({ $filter: filter, $expand: expand, $top: "2" })}`,
  );
  if (!Array.isArray(data.value))
    throw new Unconfirmed(
      "Outlook did not return a usable calendar result. Check the calendar before continuing.",
    );
  if (data.value.length > 1 || data["@odata.nextLink"])
    throw new ReviewRequired(
      "More than one Outlook event matches this action. Check the calendar before continuing.",
    );
  return data.value[0] ?? null;
}
function receipt(event: MicrosoftEvent) {
  if (!event.id || !event["@odata.etag"])
    throw new Unconfirmed(
      "Outlook returned an event without its identity or version. Check the calendar before continuing.",
    );
  return {
    eventId: event.id,
    etag: event["@odata.etag"],
    ...(event.webLink ? { url: event.webLink } : {}),
  };
}
function writable(event: MicrosoftEvent) {
  if (
    (event.attendees?.length ?? 0) > 0 ||
    event.isOrganizer === false ||
    event.isOnlineMeeting ||
    event.onlineMeeting ||
    event.hasAttachments ||
    event.recurrence ||
    (event.type && event.type !== "singleInstance")
  )
    throw new ReviewRequired(
      "This Outlook event now has guests or repeats. Handle it in Outlook to avoid sending unapproved invitations or changing a series.",
    );
}
export async function writeMicrosoftCalendar(
  token: string,
  calendarId: string,
  actionId: string,
  revision: number,
  payload: CalendarDraft,
  before?: { eventId: string; etag: string; external?: boolean },
  dispatch?: () => Promise<boolean>,
): Promise<MicrosoftCalendarReceipt | null> {
  if (payload.operation === "delete")
    return deleteMicrosoftCalendar(
      token,
      calendarId,
      actionId,
      before,
      dispatch,
    );
  const current = await readMicrosoftCalendar(
    token,
    calendarId,
    actionId,
    before,
  );
  if (current) writable(current);
  if (current && sameMicrosoftEvent(current, payload, actionId, revision))
    return receipt(current);
  if (before && (!current || current["@odata.etag"] !== before.etag))
    throw new ReviewRequired(
      "This event changed in Outlook. Review its latest details before updating.",
    );
  if (!before && current)
    throw new ReviewRequired(
      "An Outlook event already exists for this action with different details. Check the calendar before continuing.",
    );
  if (current) writable(current);
  const body: Record<string, unknown> = microsoftEventBody(
    payload,
    actionId,
    revision,
  );
  if (before?.external) {
    delete body.isReminderOn;
    body.singleValueExtendedProperties = [
      ...(current?.singleValueExtendedProperties ?? []).filter(
        (p) => ![actionProperty, revisionProperty].includes(p.id),
      ),
      ...(body.singleValueExtendedProperties as {
        id: string;
        value: string;
      }[]),
    ];
  }
  if (dispatch && !(await dispatch())) return null;
  let writtenId: string | undefined;
  try {
    const { data } = before
      ? await microsoftRequest<MicrosoftEvent>(
          token,
          `${basePath(calendarId)}/${encodeURIComponent(before.eventId)}`,
          {
            method: "PATCH",
            headers: { "If-Match": before.etag },
            body: JSON.stringify(body),
          },
        )
      : await microsoftRequest<MicrosoftEvent>(token, basePath(calendarId), {
          method: "POST",
          body: JSON.stringify({
            ...body,
            transactionId: microsoftTransactionId(actionId),
          }),
        });
    writtenId = data?.id;
  } catch (error) {
    if (providerCode(error) === 412)
      throw new ReviewRequired(
        "This Outlook event changed during approval. Review the latest details.",
      );
    const code = providerCode(error);
    if (code >= 400 && code < 500 && ![408, 409, 429].includes(code))
      throw error;
    // Never repeat the POST/PATCH here. A read can establish the outcome after a lost response.
  }
  try {
    const found = await readMicrosoftCalendar(
      token,
      calendarId,
      actionId,
      before ?? (writtenId ? { eventId: writtenId } : undefined),
    );
    if (found && sameMicrosoftEvent(found, payload, actionId, revision))
      return receipt(found);
  } catch {
    /* The write may have succeeded; failed read-back is not completion. */
  }
  throw new Unconfirmed(
    "Outlook may have accepted this change, but its contents could not be verified. Check the result before another action.",
  );
}
export async function deleteMicrosoftCalendar(
  token: string,
  calendarId: string,
  actionId: string,
  before?: { eventId: string; etag: string; external?: boolean },
  dispatch?: () => Promise<boolean>,
): Promise<MicrosoftCalendarReceipt | null> {
  if (!before)
    throw new ReviewRequired(
      "Choose an existing Daymark event before removing it.",
    );
  const current = await readMicrosoftCalendar(
    token,
    calendarId,
    actionId,
    before,
  );
  if (current && current["@odata.etag"] !== before.etag)
    throw new ReviewRequired(
      "This Outlook event changed. Review the current details before removing it.",
    );
  if (current) writable(current);
  if (dispatch && !(await dispatch())) return null;
  if (!current) return { eventId: before.eventId, etag: before.etag };
  try {
    await microsoftRequest(
      token,
      `${basePath(calendarId)}/${encodeURIComponent(before.eventId)}`,
      { method: "DELETE", headers: { "If-Match": before.etag } },
    );
  } catch (error) {
    const code = providerCode(error);
    if (code === 412)
      throw new ReviewRequired(
        "This Outlook event changed before removal. Review again.",
      );
    if (code >= 400 && code < 500 && ![404, 408, 410, 429].includes(code))
      throw error;
  }
  try {
    if (!(await readMicrosoftCalendar(token, calendarId, actionId, before)))
      return { eventId: before.eventId, etag: before.etag };
  } catch {
    /* Keep uncertain until a read confirms absence. */
  }
  throw new Unconfirmed(
    "Outlook event removal could not be verified. Check the result before another action.",
  );
}
export function microsoftEventDraft(
  event: MicrosoftEvent,
  previous: CalendarDraft,
): CalendarDraft {
  writable(event);
  if (event.isCancelled || !event["@odata.etag"])
    throw new ReviewRequired(
      "This Outlook event is unavailable. Review the calendar before continuing.",
    );
  const start = graphInstant(event.start).toZonedDateTimeISO(previous.timezone),
    end = graphInstant(event.end).toZonedDateTimeISO(previous.timezone);
  const allDay = Boolean(event.isAllDay);
  return {
    ...previous,
    title: event.subject ?? "",
    notes: event.body?.content ?? "",
    location: event.location?.displayName ?? "",
    allDay,
    date: start.toPlainDate().toString(),
    endDate: (allDay
      ? end.toPlainDate().subtract({ days: 1 })
      : end.toPlainDate()
    ).toString(),
    startTime: allDay ? null : start.toPlainTime().toString().slice(0, 5),
    endTime: allDay ? null : end.toPlainTime().toString().slice(0, 5),
    evidence: {},
  };
}
export function microsoftEmailBody(
  payload: EmailDraft,
  actionId: string,
  files: EmailFile[] = [],
) {
  if (/[\r\n]/.test(payload.to) || /[\r\n]/.test(payload.subject))
    throw new ReviewRequired(
      "Invalid email headers. Review the recipient and subject.",
    );
  if (files.length !== (payload.attachments?.length ?? 0))
    throw new ReviewRequired("Approved attachments are missing.");
  const attachments = files.map((file, index) => {
    if (
      !["image/jpeg", "image/png", "application/pdf"].includes(
        file.mediaType,
      ) ||
      file.name !== payload.attachments![index].name
    )
      throw new ReviewRequired("An approved attachment differs. Review again.");
    return {
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: file.name,
      contentType: file.mediaType,
      contentBytes: Buffer.from(file.data).toString("base64"),
    };
  });
  const body = {
    message: {
      subject: payload.subject,
      body: { contentType: "Text", content: payload.body },
      toRecipients: [{ emailAddress: { address: payload.to } }],
      internetMessageHeaders: [
        { name: "x-daymark-action", value: hash(actionId) },
      ],
      ...(attachments.length ? { attachments } : {}),
    },
    saveToSentItems: true,
  };
  // Larger uploads require Mail.ReadWrite and draft/upload-session management. Do not silently broaden send-only permission.
  if (Buffer.byteLength(JSON.stringify(body)) > 3_500_000)
    throw new ReviewRequired(
      "These attachments exceed Outlook’s direct-send size limit. Remove or reduce them, then review again.",
    );
  return body;
}
export async function sendMicrosoftEmail(
  token: string,
  payload: EmailDraft,
  actionId: string,
  files: EmailFile[] = [],
) {
  const body = microsoftEmailBody(payload, actionId, files);
  const { response } = await microsoftRequest(token, "/me/sendMail", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (response.status !== 202)
    throw new Unconfirmed(
      "Outlook did not confirm acceptance. Do not resend until the account owner checks Sent Mail.",
    );
  // Graph 202 contains no message ID and proves acceptance only, never delivery.
  const requestId = response.headers.get("request-id");
  return { accepted: true as const, ...(requestId ? { requestId } : {}) };
}
