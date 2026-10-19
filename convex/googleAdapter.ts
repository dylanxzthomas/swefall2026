"use node";
import { calendar, type calendar_v3 } from "@googleapis/calendar";
import { gmail } from "@googleapis/gmail";
import type { OAuth2Client } from "google-auth-library";
import {
  eventBody,
  sameEvent,
  hash,
  type CalendarDraft,
  type EmailDraft,
} from "../shared/daymark";
export class ReviewRequired extends Error {}
export class Unconfirmed extends Error {}
export function providerCode(error: unknown) {
  return Number((error as any)?.response?.status ?? (error as any)?.code);
}
const opts = { timeout: 25_000, retry: false };
export async function writeCalendar(
  auth: OAuth2Client,
  calendarId: string,
  actionId: string,
  revision: number,
  payload: CalendarDraft,
  before?: { eventId: string; etag: string; external?: boolean },
  dispatch?: () => Promise<boolean>,
) {
  if (payload.operation === "delete")
    return deleteCalendar(auth, calendarId, before, dispatch);
  const api = calendar({ version: "v3", auth }),
    expected = eventBody(payload, actionId, revision);
  const eventId = before?.eventId ?? `d${hash(actionId)}`;
  let current: calendar_v3.Schema$Event | undefined;
  try {
    current = (await api.events.get({ calendarId, eventId }, opts)).data;
  } catch (e) {
    if (providerCode(e) !== 404) throw e;
  }
  if (current && current.status !== "cancelled")
    assertEditableGoogleEvent(current);
  if (current && sameEvent(current, expected))
    return { eventId, etag: current.etag!, url: current.htmlLink ?? undefined };
  if (before && (!current || current.etag !== before.etag))
    throw new ReviewRequired(
      "This event changed in Google Calendar. Review its latest details before updating.",
    );
  if (!before && current)
    throw new ReviewRequired(
      "An event already exists for this action with different details. Check the calendar before continuing.",
    );
  if (dispatch && !(await dispatch())) return null;
  try {
    if (before)
      await api.events.patch(
        {
          calendarId,
          eventId,
          requestBody: before.external
            ? {
                summary: expected.summary,
                location: expected.location,
                description: expected.description,
                start: expected.start,
                end: expected.end,
                extendedProperties: {
                  ...current?.extendedProperties,
                  private: {
                    ...current?.extendedProperties?.private,
                    ...expected.extendedProperties.private,
                  },
                },
              }
            : expected,
          sendUpdates: "none",
        },
        { ...opts, headers: { "If-Match": before.etag } },
      );
    else
      await api.events.insert(
        {
          calendarId,
          requestBody: { ...expected, id: eventId },
          sendUpdates: "none",
        },
        opts,
      );
  } catch (e) {
    if (providerCode(e) === 412)
      throw new ReviewRequired(
        "This event changed while you were reviewing. Reopen its latest details.",
      );
    // A collision or transport error may mean Google accepted the write. Reconcile with the stable ID.
    if (
      providerCode(e) >= 400 &&
      providerCode(e) < 500 &&
      ![408, 409, 429].includes(providerCode(e))
    )
      throw e;
    try {
      const found = (await api.events.get({ calendarId, eventId }, opts)).data;
      if (sameEvent(found, expected) && found.etag)
        return { eventId, etag: found.etag, url: found.htmlLink ?? undefined };
    } catch {
      /* Still uncertain; never convert failed read-back to completion. */
    }
    throw new Unconfirmed(
      "Google may have accepted this update, but read-back did not confirm it. Check the result before retrying.",
    );
  }
  try {
    const found = (await api.events.get({ calendarId, eventId }, opts)).data;
    if (!sameEvent(found, expected) || !found.etag)
      throw new Error("Read-back mismatch");
    return { eventId, etag: found.etag, url: found.htmlLink ?? undefined };
  } catch {
    throw new Unconfirmed(
      "The calendar write was accepted but its contents could not be verified. Check the result.",
    );
  }
}
export type EmailFile = { name: string; mediaType: string; data: Uint8Array };
const base64Lines = (data: Uint8Array | string) =>
  Buffer.from(data)
    .toString("base64")
    .match(/.{1,76}/g)
    ?.join("\r\n") ?? "";
export function emailRaw(p: EmailDraft, id: string, files: EmailFile[] = []) {
  if (/[\r\n]/.test(p.to) || /[\r\n]/.test(p.subject))
    throw new Error("Invalid email headers.");
  if (files.length !== (p.attachments?.length ?? 0))
    throw new Error("Approved attachments are missing.");
  // Short encoded words respect RFC 2047's 75-character limit, including Unicode subjects.
  const words: string[] = [];
  let word = "";
  for (const char of p.subject) {
    if (Buffer.byteLength(word + char) > 42) {
      words.push(word);
      word = "";
    }
    word += char;
  }
  if (word) words.push(word);
  const subject = words
    .map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`)
    .join("\r\n ");
  const boundary = `daymark_${hash(id)}`;
  const headers = [
    `To: ${p.to}`,
    `Subject: ${subject}`,
    `Message-ID: <${hash(id)}@daymark.invalid>`,
    "MIME-Version: 1.0",
  ];
  const body = [
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(p.body),
  ].join("\r\n");
  let message: string;
  if (!files.length) message = [...headers, body].join("\r\n");
  else {
    const parts = files.map((f, index) => {
      if (
        !["image/jpeg", "image/png", "application/pdf"].includes(f.mediaType) ||
        f.name !== p.attachments![index].name
      )
        throw new Error("Approved attachment differs.");
      const name = encodeURIComponent(f.name).replace(
        /['()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      return [
        `Content-Type: ${f.mediaType}`,
        `Content-Disposition: attachment; filename*=UTF-8''${name}`,
        "Content-Transfer-Encoding: base64",
        "",
        base64Lines(f.data),
      ].join("\r\n");
    });
    message = [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      body,
      ...parts.flatMap((part) => [`--${boundary}`, part]),
      `--${boundary}--`,
      "",
    ].join("\r\n");
  }
  return Buffer.from(message).toString("base64url");
}
export async function sendEmail(
  auth: OAuth2Client,
  p: EmailDraft,
  actionId: string,
  files: EmailFile[] = [],
) {
  const result = await gmail({ version: "v1", auth }).users.messages.send(
    { userId: "me", requestBody: { raw: emailRaw(p, actionId, files) } },
    opts,
  );
  if (!result.data.id)
    throw new Unconfirmed(
      "Gmail did not return a message ID. Do not resend until the account owner checks Sent Mail.",
    );
  return result.data.id;
}

export async function deleteCalendar(
  auth: OAuth2Client,
  calendarId: string,
  before?: { eventId: string; etag: string; external?: boolean },
  dispatch?: () => Promise<boolean>,
) {
  if (!before)
    throw new ReviewRequired(
      "Choose an existing Daymark event before removing it.",
    );
  const api = calendar({ version: "v3", auth });
  const absent = async () => {
    try {
      return (
        (await api.events.get({ calendarId, eventId: before.eventId }, opts))
          .data.status === "cancelled"
      );
    } catch (e) {
      if (providerCode(e) === 404 || providerCode(e) === 410) return true;
      throw e;
    }
  };
  let current;
  try {
    current = (
      await api.events.get({ calendarId, eventId: before.eventId }, opts)
    ).data;
  } catch (e) {
    if (providerCode(e) !== 404 && providerCode(e) !== 410) throw e;
  }
  if (current && current.status !== "cancelled")
    assertEditableGoogleEvent(current);
  if (current && current.status !== "cancelled" && current.etag !== before.etag)
    throw new ReviewRequired(
      "This event changed. Review the current details before removing it.",
    );
  if (dispatch && !(await dispatch())) return null;
  if (!current || current.status === "cancelled")
    return { eventId: before.eventId, etag: before.etag, url: undefined };
  try {
    await api.events.delete(
      { calendarId, eventId: before.eventId, sendUpdates: "none" },
      { ...opts, headers: { "If-Match": before.etag } },
    );
  } catch (e) {
    if (providerCode(e) === 412)
      throw new ReviewRequired(
        "This event changed before removal. Review again.",
      );
    if (
      providerCode(e) >= 400 &&
      providerCode(e) < 500 &&
      ![404, 408, 410, 429].includes(providerCode(e))
    )
      throw e;
  }
  try {
    if (await absent())
      return { eventId: before.eventId, etag: before.etag, url: undefined };
  } catch {
    /* Read-back is still required for a deletion. */
  }
  throw new Unconfirmed(
    "Calendar removal could not be verified. Check the result before another action.",
  );
}

/** Basic individual events only; editing meetings/series requires provider-specific review. */
export function assertEditableGoogleEvent(event: calendar_v3.Schema$Event) {
  if (
    (event.attendees?.length ?? 0) > 0 ||
    event.recurrence?.length ||
    event.recurringEventId ||
    event.locked ||
    event.attachments?.length ||
    event.conferenceData ||
    event.hangoutLink ||
    (event.eventType && event.eventType !== "default")
  )
    throw new ReviewRequired(
      "This Google event has guests, repeats or special settings. Edit it directly in Google Calendar.",
    );
}
