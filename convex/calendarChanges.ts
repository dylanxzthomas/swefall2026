import { v, ConvexError } from "convex/values";
import {
  internalQuery,
  internalMutation,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { adult } from "./access";
import { selection } from "./providerRules";
import { calendarReadAllowed } from "../shared/calendarAwareness";
import { calendarSchema, calendarTimes, sourceHash } from "../shared/daymark";
import { googleCalendarEventsScope } from "../shared/googlePermissions";
import { coordinatorCalendarSource, validAssistantRun, preserveCalendarHandoffContext } from './assistantCoordinator'
import { calendarOrigin } from './schema'
type CalendarOrigin = { id: Id<'assistantRuns'>; version: number; index: number }
async function externalContext(
  ctx: QueryCtx | MutationCtx,
  eventId: Id<"calendarFeedEvents">,
  origin?: CalendarOrigin,
) {
  const { household, subject } = await adult(ctx),
    row = await ctx.db.get(eventId),
    feed = row && (await ctx.db.get(row.feedId)),
    connection = feed && (await ctx.db.get(feed.connectionId)),
    selected = await selection(ctx, subject, "calendar");
  if (
    !row ||
    row.householdId !== household._id ||
    row.createdBy !== subject ||
    row.expiresAt <= Date.now() ||
    !feed ||
    feed.state !== "active" ||
    feed.createdBy !== subject ||
    feed.householdId !== household._id ||
    feed.publishedRunId !== row.runId ||
    !connection ||
    connection.subject !== subject ||
    connection.householdId !== household._id ||
    connection.version !== feed.connectionVersion ||
    !calendarReadAllowed(connection) ||
    selected.connection?._id !== connection._id ||
    connection.calendarId !== row.event.calendarId ||
    !connection.scopes.includes(
      feed.provider === "google"
        ? googleCalendarEventsScope
        : "Calendars.ReadWrite",
    )
  )
    throw new ConvexError(
      "Select this calendar for approved changes and refresh its reading access first.",
    );
  const run = await ctx.db.get(row.runId);
  if (
    !run ||
    run.feedVersion !== feed.version ||
    run.expiresAt <= Date.now() ||
    !["complete", "partial"].includes(run.status)
  )
    throw new ConvexError(
      "The calendar snapshot changed. Open the current event again.",
    );
  if (origin) {
    const r = await ctx.db.get(origin.id), draft = r?.deliverables?.[origin.index]
    if (!r || r.householdId !== household._id || r.createdBy !== subject || r.status !== 'complete' || r.version !== origin.version || !Number.isInteger(origin.index) || !draft || !await validAssistantRun(ctx, { householdId: household._id, createdBy: subject, assistantRunId: r._id }) || (await coordinatorCalendarSource(ctx, r, draft))?.eventId !== eventId) throw new ConvexError('The assistant preparation or calendar source changed. Ask Sola for a fresh review.')
  }
  return {
    householdId: household._id,
    subject,
    event: row.event,
    eventId: row._id,
    feedId: feed._id,
    feedVersion: feed.version,
    provider: feed.provider,
    connectionId: connection._id,
    connectionVersion: connection.version,
    selectionVersion: selected.version,
    timezone:
      feed.calendars.find((c) => c.id === row.event.calendarId)?.timezone ||
      household.timezone,
  };
}
export const context = internalQuery({
  args: { eventId: v.id("calendarFeedEvents"), origin: v.optional(calendarOrigin) },
  handler: async (ctx, args) => externalContext(ctx, args.eventId, args.origin),
});
export const prepare = internalMutation({
  args: {
    eventId: v.id("calendarFeedEvents"),
    feedVersion: v.number(),
    connectionVersion: v.number(),
    selectionVersion: v.number(),
    etag: v.string(),
    original: v.any(),
    proposed: v.any(),
    consent: v.literal(true),
    origin: v.optional(calendarOrigin),
  },
  handler: async (ctx, args): Promise<Id<"jobs">> => {
    const current = await externalContext(ctx, args.eventId, args.origin);
    const preserveContext = args.origin ? await preserveCalendarHandoffContext(ctx, args.origin.id) : null
    if (
      current.feedVersion !== args.feedVersion ||
      current.connectionVersion !== args.connectionVersion ||
      current.selectionVersion !== args.selectionVersion ||
      !args.etag ||
      args.etag.length > 2048
    )
      throw new ConvexError(
        "Calendar access or selection changed. Review the event again.",
      );
    const original = calendarSchema.strict().parse(args.original),
      proposed = calendarSchema.strict().parse(args.proposed);
    if (proposed.operation === "delete") calendarTimes(original);
    else calendarTimes(proposed);
    if (
      original.targetId ||
      original.operation === "delete" ||
      proposed.targetId ||
      Object.keys(original.evidence).length ||
      Object.keys(proposed.evidence).length
    )
      throw new ConvexError(
        "Choose the original event through calendar review.",
      );
    const hash =
        "calendar-review:" +
        sourceHash(
          JSON.stringify([
            current.subject,
            current.feedId,
            current.event.providerId,
            args.etag,
            original,
            proposed,
          ]),
        ),
      oldSource = await ctx.db
        .query("sources")
        .withIndex("by_hash", (q) =>
          q.eq("householdId", current.householdId).eq("hash", hash),
        )
        .first();
    if (oldSource) {
      const job = await ctx.db
        .query("jobs")
        .withIndex("by_source", (q) => q.eq("sourceId", oldSource._id))
        .first();
      if (job && !job.cancelled) return job._id;
      if (job?.cancelled)
        throw new ConvexError(
          "That review was cancelled. Refresh the event to prepare another.",
        );
    }
    const text = JSON.stringify(
        {
          request:
            proposed.operation === "delete"
              ? "Review removing this calendar event."
              : "Review updating this calendar event.",
          original,
          proposed,
        },
        null,
        2,
      ),
      sourceId = await ctx.db.insert("sources", {
        householdId: current.householdId,
        text,
        hash,
        revision: 1,
        expiresAt: Date.now() + 30 * 86400_000,
      }),
      jobId = await ctx.db.insert("jobs", {
        householdId: current.householdId,
        createdBy: current.subject,
        sourceId,
        preparing: false,
        cancelled: false,
        clarification:
          "Review the original and proposed values. Nothing has been changed in your calendar.",
      }),
      actionId = await ctx.db.insert("actions", {
        householdId: current.householdId,
        jobId,
        sourceRevision: 1,
        revision: 1,
        payload: proposed,
        status: "review",
      });
    let target = await ctx.db
      .query("planEvents")
      .withIndex("by_provider_event", (q) =>
        q
          .eq("householdId", current.householdId)
          .eq("owner", current.subject)
          .eq("connectionId", current.connectionId)
          .eq("calendarId", current.event.calendarId)
          .eq("eventId", current.event.providerId),
      )
      .first();
    if (!target) {
      const id = await ctx.db.insert("planEvents", {
        householdId: current.householdId,
        owner: current.subject,
        actionId,
        connectionId: current.connectionId,
        connectionVersion: current.connectionVersion,
        provider: current.provider,
        eventId: current.event.providerId,
        calendarId: current.event.calendarId,
        etag: args.etag,
        payload: original,
        external: true,
        ...(current.event.url ? { url: current.event.url } : {}),
      });
      target = (await ctx.db.get(id))!;
    }
    const before = {
      ...target,
      payload: original,
      etag: args.etag,
      external: true,
    };
    await ctx.db.patch(actionId, {
      payload: { ...proposed, targetId: target._id },
      before,
    });
    await preserveContext?.()
    return jobId;
  },
});
