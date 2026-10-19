"use node";
import { Temporal } from "@js-temporal/polyfill";
import { calendarSchema, sourceHash } from "../shared/daymark";
import { assertEditableGoogleEvent } from "./googleAdapter";
import { calendar } from "@googleapis/calendar";
import type { OAuth2Client } from "google-auth-library";
import { randomBytes } from "node:crypto";
import { v, ConvexError } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { withGoogle, ConnectionBusy } from "./google";
import { withMicrosoft, MicrosoftConnectionBusy } from "./microsoft";
import { microsoftRequest } from "./microsoftAdapter";
import { calendarOrigin } from './schema'
import type { CoordinatorCalendarOrigin } from '../shared/assistantCoordinator'
import { providerCode } from "./googleAdapter";
import {
  calendarEventSchema,
  calendarLimits,
  eventInstant,
  safeCalendarUrl,
  validTimezone,
  type CalendarEvent,
  type CalendarSelection,
} from "../shared/calendarAwareness";
export type CalendarPage = {
  events: CalendarEvent[];
  omitted: number;
  next?: string;
};
type Raw = Record<string, any>;
function short(value: unknown, max: number) {
  return typeof value === "string" ? value.slice(0, max) : "";
}
function optional(value: unknown) {
  return typeof value === "string" && value.length <= 2048 ? value : undefined;
}
export function normalizeCalendarEvent(
  provider: "google" | "microsoft",
  raw: Raw,
  selection: CalendarSelection,
): CalendarEvent | null {
  if (
    (provider === "google" && raw.status === "cancelled") ||
    (provider === "microsoft" && (raw.isCancelled || raw["@removed"]))
  )
    return null;
  const allDay =
    provider === "google" ? !!raw.start?.date : raw.isAllDay === true;
  const zone =
    provider === "google"
      ? raw.start?.timeZone || selection.timezone
      : raw.start?.timeZone || "UTC";
  if (!validTimezone(zone)) throw new Error("Unsupported calendar timezone.");
  const startText =
    provider === "google"
      ? raw.start?.date || raw.start?.dateTime
      : raw.start?.dateTime;
  const endText =
    provider === "google"
      ? raw.end?.date || raw.end?.dateTime
      : raw.end?.dateTime;
  if (typeof startText !== "string" || typeof endText !== "string")
    throw new Error("Missing calendar time.");
  // Graph UTC preference shifts all-day instants; retain UTC instants, expose the source calendar's dates separately.
  const start = eventInstant(startText, zone, provider === "google" && allDay),
    end = eventInstant(
      endText,
      provider === "google"
        ? raw.end?.timeZone || zone
        : raw.end?.timeZone || zone,
      provider === "google" && allDay,
    );
  const event = {
    providerId: raw.id,
    calendarId: selection.id,
    title:
      short(provider === "google" ? raw.summary : raw.subject, 500) ||
      "Untitled event",
    location: short(
      provider === "google" ? raw.location : raw.location?.displayName,
      1000,
    ),
    start,
    end,
    allDay,
    timezone: zone,
    busy:
      provider === "google"
        ? raw.transparency !== "transparent" &&
          !raw.attendees?.some(
            (a: Raw) => a.self && a.responseStatus === "declined",
          )
        : raw.showAs !== "free",
    recurring:
      provider === "google"
        ? !!raw.recurringEventId
        : ["occurrence", "exception"].includes(raw.type),
    ...(allDay
      ? {
          startDate:
            provider === "google"
              ? startText
              : new Date(start).toLocaleDateString("en-CA", {
                  timeZone: selection.timezone,
                }),
          endDate:
            provider === "google"
              ? endText
              : new Date(end).toLocaleDateString("en-CA", {
                  timeZone: selection.timezone,
                }),
        }
      : {}),
    ...(optional(provider === "google" ? raw.iCalUID : raw.iCalUId)
      ? { uid: optional(provider === "google" ? raw.iCalUID : raw.iCalUId) }
      : {}),
    ...(optional(provider === "google" ? raw.etag : raw["@odata.etag"])
      ? {
          etag: optional(provider === "google" ? raw.etag : raw["@odata.etag"]),
        }
      : {}),
    ...(safeCalendarUrl(provider === "google" ? raw.htmlLink : raw.webLink)
      ? {
          url: safeCalendarUrl(
            provider === "google" ? raw.htmlLink : raw.webLink,
          ),
        }
      : {}),
  };
  return calendarEventSchema.parse(event);
}
function normalizePage(
  provider: "google" | "microsoft",
  items: unknown,
  selection: CalendarSelection,
  from: number,
  through: number,
): CalendarPage {
  if (!Array.isArray(items) || items.length > calendarLimits.page)
    throw new Error("Calendar returned an invalid page.");
  const events: CalendarEvent[] = [];
  let omitted = 0;
  for (const item of items) {
    try {
      if (!item || typeof item !== "object") throw new Error();
      const event = normalizeCalendarEvent(provider, item, selection);
      if (event && event.start < through && event.end > from)
        events.push(event);
    } catch {
      omitted++;
    }
  }
  return { events, omitted };
}
export async function readGoogleCalendarPage(
  auth: OAuth2Client,
  selection: CalendarSelection,
  from: number,
  through: number,
  pageToken?: string,
): Promise<CalendarPage> {
  const result = await calendar({ version: "v3", auth }).events.list(
    {
      calendarId: selection.id,
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(through).toISOString(),
      singleEvents: true,
      showDeleted: false,
      maxResults: calendarLimits.page,
      ...(pageToken ? { pageToken } : {}),
    },
    { timeout: 25_000, retry: false },
  );
  const page = normalizePage(
    "google",
    result.data.items === undefined ? [] : result.data.items,
    selection,
    from,
    through,
  );
  if (result.data.nextPageToken) {
    if (result.data.nextPageToken.length > 8192)
      throw new Error("Invalid calendar cursor.");
    page.next = result.data.nextPageToken;
  }
  return page;
}
export function graphCalendarPagePath(
  calendarId: string,
  next: string | undefined,
  from: number,
  through: number,
) {
  const path = `/me/calendars/${encodeURIComponent(calendarId)}/calendarView`;
  if (!next)
    return `${path}?${new URLSearchParams({ startDateTime: new Date(from).toISOString(), endDateTime: new Date(through).toISOString(), $top: String(calendarLimits.page), $select: "id,subject,start,end,isAllDay,isCancelled,showAs,type,iCalUId,webLink,location" })}`;
  if (next.length > 8192) throw new Error("Invalid calendar cursor.");
  const url = new URL(next);
  if (
    url.origin !== "https://graph.microsoft.com" ||
    url.pathname !== `/v1.0${path}` ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Untrusted calendar cursor.");
  return `${url.pathname.slice("/v1.0".length)}${url.search}`;
}
export async function readMicrosoftCalendarPage(
  token: string,
  selection: CalendarSelection,
  from: number,
  through: number,
  pageToken?: string,
): Promise<CalendarPage> {
  const { data } = await microsoftRequest<Raw>(
    token,
    graphCalendarPagePath(selection.id, pageToken, from, through),
  );
  const page = normalizePage("microsoft", data.value, selection, from, through);
  if (data["@odata.nextLink"]) {
    graphCalendarPagePath(selection.id, data["@odata.nextLink"], from, through);
    page.next = data["@odata.nextLink"];
  }
  return page;
}
export const calendars = action({
  args: { connectionId: v.id("connections"), connectionVersion: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    items: Array<CalendarSelection & { writable: boolean }>;
    hasMore: boolean;
  }> => {
    const current = await ctx.runQuery(
      internal.calendarFeeds.connectionContext,
      args,
    );
    if (!current) throw new ConvexError("Connect calendar read access first.");
    if (current.provider === "microsoft")
      return withMicrosoft(
        ctx,
        args.connectionId,
        args.connectionVersion,
        async (token) => {
          const { data } = await microsoftRequest<Raw>(
            token,
            "/me/calendars?$top=100&$select=id,name,canEdit",
          );
          if (!Array.isArray(data.value))
            throw new Error("Invalid calendar list.");
          return {
            items: data.value
              .map((r: Raw) => ({
                id: r.id,
                name: short(r.name, 200) || "Calendar",
                timezone: current.timezone,
                writable: r.canEdit === true,
              }))
              .filter((r: CalendarSelection) => typeof r.id === "string"),
            hasMore: !!data["@odata.nextLink"],
          };
        },
      );
    return withGoogle(
      ctx,
      {
        connectionId: args.connectionId,
        connectionVersion: args.connectionVersion,
      },
      async (auth) => {
        const { data } = await calendar({
          version: "v3",
          auth,
        }).calendarList.list(
          {
            maxResults: 100,
            fields:
              "items(id,summary,timeZone,accessRole,deleted),nextPageToken",
          },
          { timeout: 25_000, retry: false },
        );
        if (!Array.isArray(data.items))
          throw new Error("Invalid calendar list.");
        return {
          items: data.items
            .filter((r) => r.id && !r.deleted)
            .map((r) => ({
              id: r.id!,
              name: short(r.summary, 200) || "Calendar",
              timezone:
                r.timeZone && validTimezone(r.timeZone)
                  ? r.timeZone
                  : current.timezone,
              writable: ["owner", "writer"].includes(r.accessRole ?? ""),
            })),
          hasMore: !!data.nextPageToken,
        };
      },
    );
  },
});
export const step = internalAction({
  args: { id: v.id("calendarFeedRuns"), version: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const lease = randomBytes(20).toString("hex"),
      context = await ctx.runMutation(internal.calendarFeeds.claim, {
        ...args,
        lease,
      });
    if (!context) return;
    try {
      const selection = context.calendars[context.run.calendarIndex];
      const run = context.run;
      const read = () =>
        context.provider === "microsoft"
          ? withMicrosoft(
              ctx,
              context.connectionId,
              run.connectionVersion,
              (token) =>
                readMicrosoftCalendarPage(
                  token,
                  selection,
                  run.from,
                  run.through,
                  run.pageToken,
                ),
            )
          : withGoogle(
              ctx,
              {
                connectionId: context.connectionId,
                connectionVersion: run.connectionVersion,
              },
              (auth) =>
                readGoogleCalendarPage(
                  auth,
                  selection,
                  run.from,
                  run.through,
                  run.pageToken,
                ),
            );
      // The claimed snapshot and final commit both bind consent, membership, grant and lease.
      if (
        !(await ctx.runQuery(internal.calendarFeeds.validLease, {
          ...args,
          lease,
        }))
      )
        return;
      const page = await read();
      await ctx.runMutation(internal.calendarFeeds.commitPage, {
        ...args,
        lease,
        events: page.events,
        omitted: page.omitted,
        ...(page.next ? { next: page.next } : {}),
      });
    } catch (error) {
      if (
        error instanceof ConnectionBusy ||
        error instanceof MicrosoftConnectionBusy
      ) {
        await ctx.runMutation(internal.calendarFeeds.defer, { ...args, lease });
        return;
      }
      const code = providerCode(error);
      await ctx.runMutation(internal.calendarFeeds.failed, {
        ...args,
        lease,
        reconnect: code === 401 || code === 403,
        retry: code === 429 || code >= 500 || !code,
      });
    }
  },
});
export const selectMicrosoftCalendar = action({
  args: {
    connectionId: v.id("connections"),
    connectionVersion: v.number(),
    selectionVersion: v.number(),
    calendarId: v.string(),
  },
  handler: async (ctx, args): Promise<number> => {
    const current = await ctx.runQuery(
      internal.calendarFeeds.destinationContext,
      {
        connectionId: args.connectionId,
        connectionVersion: args.connectionVersion,
        selectionVersion: args.selectionVersion,
      },
    );
    if (current.provider !== "microsoft")
      throw new ConvexError("Choose a Microsoft calendar for this connection.");
    if (!args.calendarId.trim() || args.calendarId.length > 1024)
      throw new ConvexError("Choose a valid calendar.");
    const selected = await withMicrosoft(
      ctx,
      args.connectionId,
      args.connectionVersion,
      async (token) => {
        const { data } = await microsoftRequest<Raw>(
          token,
          `/me/calendars/${encodeURIComponent(args.calendarId)}?$select=id,name,canEdit`,
        );
        if (!data.id || data.canEdit !== true)
          throw new ConvexError(
            "This Microsoft calendar is not writable. Choose another calendar.",
          );
        return {
          calendarId: String(data.id),
          calendarName: short(data.name, 200) || "Microsoft Calendar",
        };
      },
    );
    return ctx.runMutation(internal.calendarFeeds.selectDestination, {
      connectionId: args.connectionId,
      connectionVersion: args.connectionVersion,
      selectionVersion: args.selectionVersion,
      ...selected,
    });
  },
});

export type ExternalCalendarPreview = {
  eventId: import("./_generated/dataModel").Id<"calendarFeedEvents">;
  feedVersion: number;
  connectionVersion: number;
  selectionVersion: number;
  etag: string;
  original: import("../shared/daymark").CalendarDraft;
  originalHash: string;
  provider: "google" | "microsoft";
  origin?: CoordinatorCalendarOrigin;
};
function editableDraft(
  provider: "google" | "microsoft",
  raw: Raw,
  timezone: string,
): import("../shared/daymark").CalendarDraft {
  if (provider === "google") assertEditableGoogleEvent(raw);
  else if (
    raw.isCancelled ||
    raw.isOrganizer === false ||
    (raw.attendees?.length ?? 0) > 0 ||
    raw.recurrence ||
    (raw.type && raw.type !== "singleInstance") ||
    raw.hasAttachments ||
    raw.isOnlineMeeting ||
    raw.onlineMeeting ||
    (raw.body?.contentType?.toLowerCase() !== "text" && raw.body?.content)
  )
    throw new ConvexError(
      "This Outlook event has guests, repeats or special settings. Edit it directly in Outlook Calendar.",
    );
  const normalized = normalizeCalendarEvent(provider, raw, {
    id: "external",
    name: "Calendar",
    timezone,
  });
  if (!normalized)
    throw new ConvexError("This event was removed. Refresh the calendar.");
  const start = Temporal.Instant.fromEpochMilliseconds(
      normalized.start,
    ).toZonedDateTimeISO(timezone),
    end = Temporal.Instant.fromEpochMilliseconds(
      normalized.end,
    ).toZonedDateTimeISO(timezone),
    allDay = normalized.allDay;
  return calendarSchema.strict().parse({
    kind: "calendar",
    title:
      provider === "google"
        ? raw.summary || "Untitled event"
        : raw.subject || "Untitled event",
    childId: null,
    date:
      provider === "google" && allDay
        ? raw.start.date
        : start.toPlainDate().toString(),
    endDate: allDay
      ? Temporal.PlainDate.from(
          provider === "google" ? raw.end.date : end.toPlainDate().toString(),
        )
          .subtract({ days: 1 })
          .toString()
      : end.toPlainDate().toString(),
    startTime: allDay ? null : start.toPlainTime().toString().slice(0, 5),
    endTime: allDay ? null : end.toPlainTime().toString().slice(0, 5),
    allDay,
    timezone,
    location:
      provider === "google"
        ? raw.location || ""
        : raw.location?.displayName || "",
    notes:
      provider === "google" ? raw.description || "" : raw.body?.content || "",
    targetId: null,
    evidence: {},
  });
}
async function inspectExternal(
  ctx: import("./_generated/server").ActionCtx,
  eventId: import("./_generated/dataModel").Id<"calendarFeedEvents">,
  origin?: { id: import('./_generated/dataModel').Id<'assistantRuns'>; version: number; index: number },
): Promise<ExternalCalendarPreview> {
  const context = await ctx.runQuery(internal.calendarChanges.context, {
    eventId,
    ...(origin ? { origin } : {}),
  });
  const raw: Raw =
    context.provider === "google"
      ? await withGoogle(
          ctx,
          context,
          async (auth) =>
            (
              await calendar({ version: "v3", auth }).events.get(
                {
                  calendarId: context.event.calendarId,
                  eventId: context.event.providerId,
                },
                { timeout: 25_000, retry: false },
              )
            ).data,
        )
      : await withMicrosoft(
          ctx,
          context.connectionId,
          context.connectionVersion,
          async (token) =>
            (
              await microsoftRequest<Raw>(
                token,
                `/me/calendars/${encodeURIComponent(context.event.calendarId)}/events/${encodeURIComponent(context.event.providerId)}`,
              )
            ).data,
        );
  if (raw.id !== context.event.providerId) throw new ConvexError('The calendar returned a different event. Refresh its current details.')
  const etag = context.provider === "google" ? raw.etag : raw["@odata.etag"];
  if (typeof etag !== "string" || !etag)
    throw new ConvexError(
      "This event has no usable provider version. Edit it directly in your calendar.",
    );
  const original = editableDraft(context.provider, raw, context.timezone);
  // Recheck access after the provider read; private data is never persisted by inspection.
  const after = await ctx.runQuery(internal.calendarChanges.context, {
    eventId,
    ...(origin ? { origin } : {}),
  });
  if (
    after.feedVersion !== context.feedVersion ||
    after.connectionVersion !== context.connectionVersion ||
    after.selectionVersion !== context.selectionVersion
  )
    throw new ConvexError("Calendar access changed. Open the event again.");
  return {
    eventId,
    feedVersion: context.feedVersion,
    connectionVersion: context.connectionVersion,
    selectionVersion: context.selectionVersion,
    etag,
    original,
    originalHash: sourceHash(JSON.stringify(original)),
    provider: context.provider,
    ...(origin ? { origin } : {}),
  };
}
export const inspectEvent = action({
  args: { eventId: v.id("calendarFeedEvents"), origin: v.optional(calendarOrigin) },
  handler: async (ctx, args): Promise<ExternalCalendarPreview> =>
    inspectExternal(ctx, args.eventId, args.origin),
});
export const prepareEventChange = action({
  args: {
    eventId: v.id("calendarFeedEvents"),
    feedVersion: v.number(),
    connectionVersion: v.number(),
    selectionVersion: v.number(),
    etag: v.string(),
    originalHash: v.string(),
    proposed: v.any(),
    consent: v.literal(true),
    origin: v.optional(calendarOrigin),
  },
  handler: async (ctx, args): Promise<string> => {
    const current = await inspectExternal(ctx, args.eventId, args.origin);
    if (
      current.feedVersion !== args.feedVersion ||
      current.connectionVersion !== args.connectionVersion ||
      current.selectionVersion !== args.selectionVersion ||
      current.etag !== args.etag ||
      current.originalHash !== args.originalHash
    )
      throw new ConvexError(
        "The event or account changed. Reopen its current details before preparing changes.",
      );
    const proposed = calendarSchema.strict().parse(args.proposed);
    if (proposed.targetId || Object.keys(proposed.evidence).length)
      throw new ConvexError("Choose the event through calendar review.");
    return ctx.runMutation(internal.calendarChanges.prepare, {
      eventId: args.eventId,
      feedVersion: args.feedVersion,
      connectionVersion: args.connectionVersion,
      selectionVersion: args.selectionVersion,
      etag: current.etag,
      original: current.original,
      proposed,
      consent: true,
      ...(args.origin ? { origin: args.origin } : {}),
    });
  },
});
