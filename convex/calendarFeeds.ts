import { v, ConvexError } from "convex/values";
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { adult } from "./access";
import { sourceHash } from "../shared/daymark";
import {
  calendarEventSchema,
  calendarLimits,
  calendarReadAllowed,
  calendarSelectionSchema,
  calendarWindow,
  findCalendarConflicts,
  type CalendarEvent,
} from "../shared/calendarAwareness";
type Ctx = QueryCtx | MutationCtx;
type Feed = Doc<"calendarFeeds">;
type Run = Doc<"calendarFeedRuns">;
const runArgs = { id: v.id("calendarFeedRuns"), version: v.number() },
  leaseArgs = { ...runArgs, lease: v.string() };
const selectionValidator = v.object({
  id: v.string(),
  name: v.string(),
  timezone: v.string(),
});
const eventValidator = v.object({
  providerId: v.string(),
  calendarId: v.string(),
  title: v.string(),
  location: v.string(),
  start: v.number(),
  end: v.number(),
  allDay: v.boolean(),
  startDate: v.optional(v.string()),
  endDate: v.optional(v.string()),
  timezone: v.string(),
  busy: v.boolean(),
  recurring: v.boolean(),
  uid: v.optional(v.string()),
  url: v.optional(v.string()),
  etag: v.optional(v.string()),
});
function accountKey(c: Doc<"connections">) {
  return sourceHash(JSON.stringify([c._id, c.accountId || c.email]));
}
async function live(ctx: Ctx, feed: Feed) {
  const connection = await ctx.db.get(feed.connectionId),
    household = await ctx.db.get(feed.householdId),
    member = await ctx.db
      .query("memberships")
      .withIndex("by_subject", (q) => q.eq("subject", feed.createdBy))
      .unique();
  return feed.state === "active" &&
    household &&
    !household.deleted &&
    member?.householdId === feed.householdId &&
    connection &&
    connection.householdId === feed.householdId &&
    connection.subject === feed.createdBy &&
    connection.version === feed.connectionVersion &&
    accountKey(connection) === feed.accountKey &&
    calendarReadAllowed(connection)
    ? { connection, household }
    : null;
}
async function held(
  ctx: Ctx,
  args: { id: Id<"calendarFeedRuns">; version: number; lease: string },
) {
  const run = await ctx.db.get(args.id);
  if (
    !run ||
    run.version !== args.version ||
    run.status !== "running" ||
    run.lease !== args.lease ||
    (run.leaseUntil ?? 0) <= Date.now() ||
    run.expiresAt <= Date.now()
  )
    return null;
  const feed = await ctx.db.get(run.feedId);
  if (
    !feed ||
    feed.version !== run.feedVersion ||
    feed.activeRunId !== run._id ||
    !(await live(ctx, feed))
  )
    return null;
  return { run, feed };
}
async function owned(ctx: Ctx, id: Id<"calendarFeeds">) {
  const { household, subject } = await adult(ctx),
    feed = await ctx.db.get(id);
  if (
    !feed ||
    feed.createdBy !== subject ||
    feed.householdId !== household._id ||
    feed.state === "removed"
  )
    throw new ConvexError("This calendar connection is unavailable.");
  return feed;
}
async function start(
  ctx: MutationCtx,
  feed: Feed,
): Promise<Id<"calendarFeedRuns">> {
  if (!(await live(ctx, feed)))
    throw new ConvexError(
      "Reconnect calendar read access and confirm selected calendars.",
    );
  const old = feed.activeRunId && (await ctx.db.get(feed.activeRunId));
  if (
    old &&
    ["queued", "running"].includes(old.status) &&
    old.feedVersion === feed.version &&
    old.expiresAt > Date.now()
  )
    return old._id;
  const household = (await ctx.db.get(feed.householdId))!,
    window = calendarWindow(Date.now(), household.timezone),
    id = await ctx.db.insert("calendarFeedRuns", {
      householdId: feed.householdId,
      createdBy: feed.createdBy,
      feedId: feed._id,
      feedVersion: feed.version,
      connectionVersion: feed.connectionVersion,
      version: 1,
      status: "queued",
      ...window,
      calendarIndex: 0,
      pages: 0,
      eventCount: 0,
      omitted: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + calendarLimits.retentionMs,
    });
  await ctx.db.patch(feed._id, {
    activeRunId: id,
    nextCheckAt: Date.now() + calendarLimits.refreshMs,
    issue: undefined,
  });
  await ctx.scheduler.runAfter(0, internal.calendarReading.step, {
    id,
    version: 1,
  });
  return id;
}
export const connectionContext = internalQuery({
  args: { connectionId: v.id("connections"), connectionVersion: v.number() },
  handler: async (ctx, args) => {
    const { household, subject } = await adult(ctx),
      c = await ctx.db.get(args.connectionId);
    if (
      !c ||
      c.householdId !== household._id ||
      c.subject !== subject ||
      c.version !== args.connectionVersion ||
      !calendarReadAllowed(c)
    )
      return null;
    return {
      provider:
        c.provider === "microsoft"
          ? ("microsoft" as const)
          : ("google" as const),
      timezone: household.timezone,
    };
  },
});
export const save = mutation({
  args: {
    connectionId: v.id("connections"),
    connectionVersion: v.number(),
    calendars: v.array(selectionValidator),
    consent: v.boolean(),
    version: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Id<"calendarFeeds">> => {
    const { household, subject } = await adult(ctx),
      connection = await ctx.db.get(args.connectionId);
    if (!args.consent)
      throw new ConvexError("Confirm private calendar processing first.");
    if (
      !connection ||
      connection.subject !== subject ||
      connection.householdId !== household._id ||
      connection.version !== args.connectionVersion ||
      !calendarReadAllowed(connection)
    )
      throw new ConvexError("Connect calendar read access first.");
    const parsed = calendarSelectionSchema.safeParse(args.calendars);
    if (!parsed.success)
      throw new ConvexError(
        "Choose one to five distinct calendars with valid timezones.",
      );
    const existing = (
      await ctx.db
        .query("calendarFeeds")
        .withIndex("by_owner", (q) =>
          q.eq("householdId", household._id).eq("createdBy", subject),
        )
        .collect()
    ).find((f) => f.connectionId === connection._id && f.state !== "removed");
    if (existing && args.version !== existing.version)
      throw new ConvexError("Calendar settings changed. Open them again.");
    const fields = {
      householdId: household._id,
      createdBy: subject,
      connectionId: connection._id,
      connectionVersion: connection.version,
      provider:
        connection.provider === "microsoft"
          ? ("microsoft" as const)
          : ("google" as const),
      accountKey: accountKey(connection),
      version: (existing?.version ?? 0) + 1,
      state: "active" as const,
      calendars: parsed.data,
      consentedAt: Date.now(),
      createdAt: existing?.createdAt ?? Date.now(),
    };
    let id: Id<"calendarFeeds">;
    if (existing) {
      id = existing._id;
      await ctx.runMutation(internal.calendarAssistance.cancel, {
        feedId: existing._id,
      });
      await ctx.db.patch(id, {
        ...fields,
        assistanceEnabled: false,
        assistanceVersion: (existing.assistanceVersion ?? 0) + 1,
        assistanceBaselineRunId: undefined,
        assistancePendingId: undefined,
        assistanceIssue: undefined,
        activeRunId: undefined,
        publishedRunId: undefined,
        lastCheckedAt: undefined,
        issue: undefined,
      });
      if (existing.activeRunId)
        await ctx.db.patch(existing.activeRunId, {
          status: "cancelled",
          lease: undefined,
          leaseUntil: undefined,
        });
      if (existing.publishedRunId)
        await ctx.scheduler.runAfter(0, internal.calendarFeeds.cleanupRun, {
          id: existing.publishedRunId,
        });
    } else id = await ctx.db.insert("calendarFeeds", fields);
    await start(ctx, (await ctx.db.get(id))!);
    return id;
  },
});
export const sync = mutation({
  args: { id: v.id("calendarFeeds"), version: v.number() },
  handler: async (ctx, args): Promise<Id<"calendarFeedRuns">> => {
    const feed = await owned(ctx, args.id);
    if (feed.version !== args.version)
      throw new ConvexError("Calendar settings changed. Open them again.");
    if (
      feed.lastCheckedAt &&
      Date.now() - feed.lastCheckedAt < 30_000 &&
      !feed.activeRunId
    )
      throw new ConvexError("Calendar was just checked. Try again shortly.");
    if (!feed.activeRunId) {
      const recent = await ctx.db
        .query("calendarFeedRuns")
        .withIndex("by_feed", (q) => q.eq("feedId", feed._id))
        .order("desc")
        .first();
      if (recent && Date.now() - recent.createdAt < 30_000)
        throw new ConvexError("Calendar was just checked. Try again shortly.");
    }
    return start(ctx, feed);
  },
});
export const change = mutation({
  args: {
    id: v.id("calendarFeeds"),
    version: v.number(),
    operation: v.union(
      v.literal("pause"),
      v.literal("remove"),
      v.literal("resume"),
    ),
    consent: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const feed = await owned(ctx, args.id);
    if (feed.version !== args.version)
      throw new ConvexError("Calendar settings changed. Open them again.");
    if (args.operation === "resume" && !args.consent)
      throw new ConvexError("Confirm private calendar processing first.");
    await ctx.db.patch(feed._id, {
      version: feed.version + 1,
      state:
        args.operation === "remove"
          ? "removed"
          : args.operation === "pause"
            ? "paused"
            : "active",
      activeRunId: undefined,
      nextCheckAt: undefined,
      issue: undefined,
    });
    await ctx.runMutation(internal.calendarAssistance.cancel, {
      feedId: feed._id,
    });
    if (feed.activeRunId)
      await ctx.db.patch(feed.activeRunId, {
        status: "cancelled",
        lease: undefined,
        leaseUntil: undefined,
      });
    if (args.operation === "remove") {
      await ctx.scheduler.runAfter(0, internal.calendarFeeds.cleanupFeed, {
        id: feed._id,
      });
      return;
    }
    if (args.operation === "resume")
      await start(ctx, (await ctx.db.get(feed._id))!);
  },
});
export const settings = query({
  args: {},
  handler: async (ctx) => {
    const { household, subject } = await adult(ctx);
    return Promise.all(
      (
        await ctx.db
          .query("calendarFeeds")
          .withIndex("by_owner", (q) =>
            q.eq("householdId", household._id).eq("createdBy", subject),
          )
          .collect()
      )
        .filter((f) => f.state !== "removed")
        .map(async (f) => {
          const active = f.activeRunId && (await ctx.db.get(f.activeRunId)),
            run = f.publishedRunId && (await ctx.db.get(f.publishedRunId));
          return {
            id: f._id,
            version: f.version,
            assistanceEnabled: !!f.assistanceEnabled,
            assistanceVersion: f.assistanceVersion ?? 0,
            assistanceConfigured:
              !!process.env.ANTHROPIC_API_KEY && !!process.env.DAYMARK_MODEL,
            assistanceIssue: f.assistanceIssue,
            connectionId: f.connectionId,
            connectionVersion: f.connectionVersion,
            provider: f.provider,
            state: f.state,
            calendars: f.calendars,
            lastCheckedAt: f.lastCheckedAt,
            issue: f.issue,
            needsReconnect: !(await live(ctx, { ...f, state: "active" })),
            syncing: !!active && ["queued", "running"].includes(active.status),
            coverage: run
              ? {
                  from: run.from,
                  through: run.through,
                  partial: run.status === "partial",
                  omitted: run.omitted,
                  count: run.eventCount,
                }
              : null,
          };
        }),
    );
  },
});
export const claim = internalMutation({
  args: leaseArgs,
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.id);
    if (
      !run ||
      run.version !== args.version ||
      !["queued", "running"].includes(run.status) ||
      (run.leaseUntil ?? 0) > Date.now()
    )
      return null;
    const feed = await ctx.db.get(run.feedId);
    if (
      run.expiresAt <= Date.now() ||
      !feed ||
      feed.version !== run.feedVersion ||
      feed.activeRunId !== run._id ||
      !(await live(ctx, feed))
    ) {
      await ctx.db.patch(run._id, {
        status: "cancelled",
        lease: undefined,
        leaseUntil: undefined,
      });
      return null;
    }
    if ((run.attempts ?? 0) >= calendarLimits.pages * 3) {
      const issue =
        "Calendar reading stopped after repeated interruptions. Check again to start a new snapshot.";
      await ctx.db.patch(run._id, {
        status: "failed",
        issue,
        lease: undefined,
        leaseUntil: undefined,
      });
      await ctx.db.patch(feed._id, {
        activeRunId: undefined,
        issue,
        nextCheckAt: Date.now() + 3600_000,
      });
      return null;
    }
    await ctx.db.patch(run._id, {
      attempts: (run.attempts ?? 0) + 1,
      status: "running",
      lease: args.lease,
      leaseUntil: Date.now() + calendarLimits.leaseMs,
    });
    await ctx.scheduler.runAfter(
      calendarLimits.leaseMs + 1000,
      internal.calendarFeeds.recover,
      runArgsFor(run),
    );
    return {
      run,
      connectionId: feed.connectionId,
      provider: feed.provider,
      calendars: feed.calendars,
    };
  },
});
function runArgsFor(run: Run) {
  return { id: run._id, version: run.version };
}
export const validLease = internalQuery({
  args: leaseArgs,
  handler: async (ctx, args) => !!(await held(ctx, args)),
});
export const commitPage = internalMutation({
  args: {
    ...leaseArgs,
    events: v.array(eventValidator),
    omitted: v.number(),
    next: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const current = await held(ctx, args);
    if (!current) return false;
    const { run, feed } = current;
    if (
      args.events.length > calendarLimits.page ||
      !Number.isInteger(args.omitted) ||
      args.omitted < 0 ||
      args.omitted > calendarLimits.page ||
      args.events.length + args.omitted > calendarLimits.page ||
      (args.next && args.next.length > 8192)
    )
      throw new ConvexError("Invalid calendar page.");
    const selection = feed.calendars[run.calendarIndex];
    let inserted = 0;
    for (const raw of args.events) {
      const event = calendarEventSchema.parse(raw);
      if (
        event.calendarId !== selection.id ||
        event.start >= run.through ||
        event.end <= run.from
      )
        throw new ConvexError("Calendar event is outside this selection.");
      const key = sourceHash(JSON.stringify([selection.id, event.providerId])),
        old = await ctx.db
          .query("calendarFeedEvents")
          .withIndex("by_key", (q) => q.eq("runId", run._id).eq("key", key))
          .unique();
      if (!old) {
        inserted++;
        await ctx.db.insert("calendarFeedEvents", {
          householdId: feed.householdId,
          createdBy: feed.createdBy,
          feedId: feed._id,
          runId: run._id,
          key,
          event,
          expiresAt: run.expiresAt,
        });
      } else if (JSON.stringify(old.event) !== JSON.stringify(event))
        await ctx.db.patch(old._id, { event });
    }
    const pages = run.pages + 1,
      eventCount = run.eventCount + inserted,
      omitted = run.omitted + args.omitted,
      calendarIndex = args.next ? run.calendarIndex : run.calendarIndex + 1,
      limited =
        pages >= calendarLimits.pages || eventCount >= calendarLimits.events,
      finished = calendarIndex >= feed.calendars.length || limited,
      version = run.version + 1;
    await ctx.db.patch(run._id, {
      pages,
      eventCount,
      omitted,
      calendarIndex,
      version,
      status: finished
        ? omitted ||
          (limited && calendarIndex < feed.calendars.length) ||
          (limited && !!args.next)
          ? "partial"
          : "complete"
        : "queued",
      pageToken: args.next,
      lease: undefined,
      leaseUntil: undefined,
    });
    if (finished) {
      const previous = feed.publishedRunId;
      await ctx.db.patch(feed._id, {
        publishedRunId: run._id,
        activeRunId: undefined,
        lastCheckedAt: Date.now(),
        nextCheckAt: Date.now() + calendarLimits.refreshMs,
        issue: omitted
          ? "Some calendar items could not be read."
          : limited && (calendarIndex < feed.calendars.length || args.next)
            ? "Only part of the selected calendar window was read."
            : undefined,
      });
      if (
        finished &&
        !omitted &&
        !(limited && (calendarIndex < feed.calendars.length || args.next))
      ) {
        try {
          await ctx.runMutation(internal.calendarAssistance.observe, {
            feedId: feed._id,
            runId: run._id,
            ...(previous ? { previousRunId: previous } : {}),
          });
        } catch {
          await ctx.db.patch(feed._id, {
            assistanceIssue:
              "Calendar follow-ups could not be prepared. Check the current calendar again.",
          });
        }
      }
      if (previous && previous !== run._id)
        await ctx.scheduler.runAfter(0, internal.calendarFeeds.cleanupRun, {
          id: previous,
        });
    } else
      await ctx.scheduler.runAfter(0, internal.calendarReading.step, {
        id: run._id,
        version,
      });
    return true;
  },
});
export const failed = internalMutation({
  args: { ...leaseArgs, reconnect: v.boolean(), retry: v.boolean() },
  handler: async (ctx, args) => {
    const current = await held(ctx, args);
    if (!current) return false;
    const issue = args.reconnect
      ? "Reconnect calendar access."
      : "Calendar could not be checked. The previous snapshot may be out of date.";
    await ctx.db.patch(current.run._id, {
      status: "failed",
      issue,
      lease: undefined,
      leaseUntil: undefined,
    });
    await ctx.db.patch(current.feed._id, {
      activeRunId: undefined,
      issue,
      nextCheckAt: args.reconnect
        ? undefined
        : Date.now() + (args.retry ? calendarLimits.refreshMs : 3600_000),
    });
    await ctx.scheduler.runAfter(0, internal.calendarFeeds.cleanupRun, {
      id: current.run._id,
    });
    return true;
  },
});
export const recover = internalMutation({
  args: runArgs,
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.id);
    if (
      !run ||
      run.version !== args.version ||
      !["queued", "running"].includes(run.status) ||
      (run.leaseUntil ?? 0) > Date.now()
    )
      return;
    await ctx.scheduler.runAfter(0, internal.calendarReading.step, args);
  },
});
export const poll = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const run of await ctx.db
      .query("calendarFeedRuns")
      .withIndex("by_expiry", (q) => q.lte("expiresAt", Date.now()))
      .take(25)) {
      const feed = await ctx.db.get(run.feedId);
      if (feed)
        await ctx.db.patch(feed._id, {
          ...(feed.publishedRunId === run._id
            ? { publishedRunId: undefined }
            : {}),
          ...(feed.activeRunId === run._id ? { activeRunId: undefined } : {}),
        });
      if (["queued", "running"].includes(run.status))
        await ctx.db.patch(run._id, {
          status: "cancelled",
          lease: undefined,
          leaseUntil: undefined,
        });
      await ctx.scheduler.runAfter(0, internal.calendarFeeds.cleanupRun, {
        id: run._id,
      });
    }
    const due = await ctx.db
      .query("calendarFeeds")
      .withIndex("by_due", (q) =>
        q.eq("state", "active").lte("nextCheckAt", Date.now()),
      )
      .take(25);
    for (const feed of due) {
      if (!(await live(ctx, feed))) {
        await ctx.db.patch(feed._id, {
          nextCheckAt: undefined,
          issue: "Reconnect calendar access and confirm selected calendars.",
        });
        continue;
      }
      await start(ctx, feed);
    }
  },
});
async function privateContext(
  ctx: Ctx,
  householdId: Id<"households">,
  subject: string,
  from: number,
  through: number,
) {
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(through) ||
    through <= from ||
    through - from > 98 * 86400_000
  )
    throw new ConvexError("Choose a calendar range of at most 98 days.");
  const feeds = await ctx.db
      .query("calendarFeeds")
      .withIndex("by_owner", (q) =>
        q.eq("householdId", householdId).eq("createdBy", subject),
      )
      .collect(),
    events: Array<
      CalendarEvent & {
        id: Id<"calendarFeedEvents">;
        feedId: Id<"calendarFeeds">;
        provider: "google" | "microsoft";
        connectionId: Id<"connections">;
        connectionVersion: number;
        syncedAt: number;
      }
    > = [],
    coverage: Array<{
      feedId: Id<"calendarFeeds">;
      provider: "google" | "microsoft";
      connectionId: Id<"connections">;
      connectionVersion: number;
      calendars: string[];
      from: number;
      through: number;
      complete: boolean;
      fresh: boolean;
      issue?: string;
    }> = [];
  for (const feed of feeds) {
    if (!(await live(ctx, feed))) continue;
    const run = feed.publishedRunId && (await ctx.db.get(feed.publishedRunId));
    if (
      !run ||
      run.expiresAt <= Date.now() ||
      run.feedVersion !== feed.version ||
      !["complete", "partial"].includes(run.status)
    )
      continue;
    const fresh =
      !!feed.lastCheckedAt &&
      Date.now() - feed.lastCheckedAt <= calendarLimits.freshnessMs;
    coverage.push({
      feedId: feed._id,
      provider: feed.provider,
      connectionId: feed.connectionId,
      connectionVersion: feed.connectionVersion,
      calendars: feed.calendars.map(c => c.id),
      from: run.from,
      through: run.through,
      complete: run.status === "complete" && run.omitted === 0,
      fresh,
      ...(feed.issue ? { issue: feed.issue } : {}),
    });
    for (const row of await ctx.db
      .query("calendarFeedEvents")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .take(calendarLimits.events))
      if (row.event.start < through && row.event.end > from)
        events.push({
          ...row.event,
          id: row._id,
          feedId: feed._id,
          provider: feed.provider,
          connectionId: feed.connectionId,
          connectionVersion: feed.connectionVersion,
          syncedAt: feed.lastCheckedAt!,
        });
  }
  return {
    owner: subject,
    from,
    through,
    events: events.sort((a, b) => a.start - b.start).slice(0, 500),
    truncated: events.length > 500,
    coverage,
    availabilityKnown:
      coverage.length > 0 &&
      coverage.length === feeds.filter((f) => f.state !== "removed").length &&
      events.length <= 500 &&
      coverage.every(
        (c) =>
          c.complete &&
          c.fresh &&
          !c.issue &&
          c.from <= from &&
          c.through >= through,
      ),
    private: true as const,
  };
}
export const agenda = query({
  args: { from: v.number(), through: v.number() },
  handler: async (ctx, args) => {
    const { household, subject } = await adult(ctx);
    return privateContext(ctx, household._id, subject, args.from, args.through);
  },
});
export const conflicts = query({
  args: {
    start: v.number(),
    end: v.number(),
    ignoreUid: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { household, subject } = await adult(ctx),
      context = await privateContext(
        ctx,
        household._id,
        subject,
        args.start,
        args.end,
      );
    return {
      conflicts: findCalendarConflicts(
        context.events,
        args.start,
        args.end,
        args.ignoreUid,
      ),
      availabilityKnown: context.availabilityKnown,
      coverage: context.coverage,
    };
  },
});
export const contextForAdult = internalQuery({
  args: {
    householdId: v.id("households"),
    subject: v.string(),
    from: v.number(),
    through: v.number(),
  },
  handler: async (ctx, args) => {
    const member = await ctx.db
        .query("memberships")
        .withIndex("by_subject", (q) => q.eq("subject", args.subject))
        .unique(),
      h = await ctx.db.get(args.householdId);
    if (member?.householdId !== args.householdId || !h || h.deleted)
      return null;
    return privateContext(
      ctx,
      args.householdId,
      args.subject,
      args.from,
      args.through,
    );
  },
});
export const cleanupRun = internalMutation({
  args: { id: v.id("calendarFeedRuns") },
  handler: async (ctx, { id }) => {
    const run = await ctx.db.get(id);
    if (!run) return;
    const feed = await ctx.db.get(run.feedId);
    if (
      feed &&
      feed.state !== "removed" &&
      (feed.activeRunId === id || feed.publishedRunId === id)
    )
      return;
    const rows = await ctx.db
      .query("calendarFeedEvents")
      .withIndex("by_run", (q) => q.eq("runId", id))
      .take(100);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === 100)
      await ctx.scheduler.runAfter(0, internal.calendarFeeds.cleanupRun, {
        id,
      });
    else await ctx.db.delete(id);
  },
});
export const cleanupFeed = internalMutation({
  args: { id: v.id("calendarFeeds") },
  handler: async (ctx, { id }) => {
    const feed = await ctx.db.get(id);
    if (!feed || feed.state !== "removed") return;
    const runs = await ctx.db
      .query("calendarFeedRuns")
      .withIndex("by_feed", (q) => q.eq("feedId", id))
      .take(10);
    for (const run of runs)
      await ctx.scheduler.runAfter(0, internal.calendarFeeds.cleanupRun, {
        id: run._id,
      });
    if (runs.length)
      await ctx.scheduler.runAfter(1000, internal.calendarFeeds.cleanupFeed, {
        id,
      });
    else
      await ctx.db.patch(id, {
        calendars: [],
        accountKey: "",
        issue: undefined,
      });
  },
});

/** Destination selection changes the review selection version, not the OAuth grant revision. */
export const destinationContext = internalQuery({
  args: {
    connectionId: v.id("connections"),
    connectionVersion: v.number(),
    selectionVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const { household, subject } = await adult(ctx),
      c = await ctx.db.get(args.connectionId),
      p = await ctx.db
        .query("connectionPreferences")
        .withIndex("by_subject", (q) => q.eq("subject", subject))
        .unique();
    if (
      !c ||
      c.householdId !== household._id ||
      c.subject !== subject ||
      c.status !== "active" ||
      c.version !== args.connectionVersion ||
      c.provider === "apple" ||
      !c.scopes.includes(
        c.provider === "microsoft"
          ? "Calendars.ReadWrite"
          : "https://www.googleapis.com/auth/calendar.events",
      ) ||
      (p?.version ?? 0) !== args.selectionVersion
    )
      throw new ConvexError(
        "Calendar account or permission changed. Reopen settings.",
      );
    return { provider: c.provider ?? "google", email: c.email };
  },
});
export const selectDestination = internalMutation({
  args: {
    connectionId: v.id("connections"),
    connectionVersion: v.number(),
    selectionVersion: v.number(),
    calendarId: v.string(),
    calendarName: v.string(),
  },
  handler: async (ctx, args): Promise<number> => {
    const { household, subject } = await adult(ctx),
      c = await ctx.db.get(args.connectionId),
      p = await ctx.db
        .query("connectionPreferences")
        .withIndex("by_subject", (q) => q.eq("subject", subject))
        .unique();
    if (
      !c ||
      c.householdId !== household._id ||
      c.subject !== subject ||
      c.status !== "active" ||
      c.version !== args.connectionVersion ||
      c.provider === "apple" ||
      !c.scopes.includes(
        c.provider === "microsoft"
          ? "Calendars.ReadWrite"
          : "https://www.googleapis.com/auth/calendar.events",
      ) ||
      (p?.version ?? 0) !== args.selectionVersion ||
      (c.lockUntil ?? 0) > Date.now()
    )
      throw new ConvexError(
        "Calendar account, permission or destination selection changed. Reopen settings.",
      );
    if (
      !args.calendarId.trim() ||
      args.calendarId.length > 1024 ||
      !args.calendarName.trim() ||
      args.calendarName.length > 200
    )
      throw new ConvexError("Choose a valid writable calendar.");
    await ctx.db.patch(c._id, {
      calendarId: args.calendarId,
      calendarName: args.calendarName,
    });
    const version = (p?.version ?? 0) + 1;
    if (p) await ctx.db.patch(p._id, { calendarConnectionId: c._id, version });
    else
      await ctx.db.insert("connectionPreferences", {
        householdId: household._id,
        subject,
        calendarConnectionId: c._id,
        version,
      });
    return version;
  },
});
/** A verified write requests a new snapshot; it never manufactures a synced event. */
export const afterWrite = internalMutation({
  args: { connectionId: v.id("connections"), calendarId: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.connectionId);
    if (!c) return;
    const feeds = await ctx.db
      .query("calendarFeeds")
      .withIndex("by_owner", (q) =>
        q.eq("householdId", c.householdId).eq("createdBy", c.subject),
      )
      .collect();
    for (const feed of feeds)
      if (
        feed.connectionId === c._id &&
        feed.calendars.some((calendar) => calendar.id === args.calendarId) &&
        (await live(ctx, feed))
      ) {
        if (feed.activeRunId) {
          const run = await ctx.db.get(feed.activeRunId);
          if (run && ["queued", "running"].includes(run.status))
            await ctx.db.patch(run._id, {
              status: "cancelled",
              lease: undefined,
              leaseUntil: undefined,
            });
          await ctx.scheduler.runAfter(0, internal.calendarFeeds.cleanupRun, {
            id: feed.activeRunId,
          });
        }
        await ctx.runMutation(internal.calendarAssistance.cancel, {
          feedId: feed._id,
        });
        await ctx.db.patch(feed._id, {
          version: feed.version + 1,
          activeRunId: undefined,
        });
        await start(ctx, (await ctx.db.get(feed._id))!);
      }
  },
});
export const defer = internalMutation({
  args: leaseArgs,
  handler: async (ctx, args) => {
    const current = await held(ctx, args);
    if (!current) return false;
    const version = current.run.version + 1;
    await ctx.db.patch(current.run._id, {
      version,
      status: "queued",
      lease: undefined,
      leaseUntil: undefined,
    });
    await ctx.scheduler.runAfter(2000, internal.calendarReading.step, {
      id: current.run._id,
      version,
    });
    return true;
  },
});
