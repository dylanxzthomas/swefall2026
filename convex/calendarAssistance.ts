import { v, ConvexError } from "convex/values";
import {
  mutation,
  internalMutation,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { adult } from "./access";
import { sourceHash } from "../shared/daymark";
import {
  calendarLimits,
  calendarReadAllowed,
  type CalendarEvent,
} from "../shared/calendarAwareness";
import {
  calendarAssistanceLimits,
  calendarChanges,
  calendarIdentity,
  calendarChangeEvidence,
  sameCalendarMeaning,
  mergeCalendarChanges,
  type CalendarChange,
} from "../shared/calendarAssistance";
type Ctx = Pick<QueryCtx, "db">;
const configured = () =>
  !!process.env.ANTHROPIC_API_KEY && !!process.env.DAYMARK_MODEL;
async function live(ctx: Ctx, feed: Doc<"calendarFeeds">) {
  const c = await ctx.db.get(feed.connectionId),
    h = await ctx.db.get(feed.householdId),
    m = await ctx.db
      .query("memberships")
      .withIndex("by_subject", (q) => q.eq("subject", feed.createdBy))
      .unique();
  return (
    feed.state === "active" &&
    !!h &&
    !h.deleted &&
    m?.householdId === feed.householdId &&
    !!c &&
    c.subject === feed.createdBy &&
    c.householdId === feed.householdId &&
    c.version === feed.connectionVersion &&
    calendarReadAllowed(c) &&
    feed.accountKey ===
      sourceHash(JSON.stringify([c._id, c.accountId || c.email]))
  );
}
async function snapshot(
  ctx: Ctx,
  feed: Doc<"calendarFeeds">,
  id: Id<"calendarFeedRuns"> | undefined,
) {
  const run = id ? await ctx.db.get(id) : null;
  return run &&
    run.feedId === feed._id &&
    run.householdId === feed.householdId &&
    run.createdBy === feed.createdBy &&
    run.feedVersion === feed.version &&
    run.status === "complete" &&
    run.omitted === 0 &&
    run.expiresAt > Date.now() &&
    Date.now() - run.createdAt <= calendarLimits.freshnessMs
    ? run
    : null;
}
async function events(ctx: Ctx, runId: Id<"calendarFeedRuns">) {
  return (
    await ctx.db
      .query("calendarFeedEvents")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .take(calendarLimits.events)
  ).map((r) => r.event);
}
async function stop(
  ctx: MutationCtx,
  feed: Doc<"calendarFeeds">,
  issue: string,
) {
  const pending =
    feed.assistancePendingId && (await ctx.db.get(feed.assistancePendingId));
  if (pending && ["queued", "started"].includes(pending.status)) {
    await ctx.db.patch(pending._id, {
      status: "cancelled",
      version: pending.version + 1,
      issue,
    });
    if (pending.jobId) {
      const job = await ctx.db.get(pending.jobId);
      if (
        job &&
        job.createdBy === feed.createdBy &&
        job.householdId === feed.householdId
      )
        await ctx.db.patch(job._id, { cancelled: true, preparing: false });
    }
  }
  await ctx.db.patch(feed._id, { assistancePendingId: undefined });
}
export const setEnabled = mutation({
  args: {
    feedId: v.id("calendarFeeds"),
    feedVersion: v.number(),
    assistanceVersion: v.number(),
    enabled: v.boolean(),
    consent: v.optional(v.literal(true)),
  },
  handler: async (ctx, args): Promise<void> => {
    const { household, subject } = await adult(ctx),
      feed = await ctx.db.get(args.feedId);
    if (
      !feed ||
      feed.householdId !== household._id ||
      feed.createdBy !== subject ||
      feed.state === "removed"
    )
      throw new ConvexError("This private calendar is unavailable.");
    if (
      feed.version !== args.feedVersion ||
      (feed.assistanceVersion ?? 0) !== args.assistanceVersion
    )
      throw new ConvexError(
        "Calendar follow-up settings changed. Reopen them.",
      );
    if (args.enabled && (!args.consent || !(await live(ctx, feed))))
      throw new ConvexError(
        "Confirm private calendar follow-ups and current reading access first.",
      );
    if (args.enabled && !configured())
      throw new ConvexError(
        "Calendar follow-ups need the assistant model configured first.",
      );
    await stop(ctx, feed, "Calendar follow-up permission changed.");
    const baseline = args.enabled
      ? await snapshot(ctx, feed, feed.publishedRunId)
      : null;
    await ctx.db.patch(feed._id, {
      assistanceEnabled: args.enabled,
      assistanceVersion: (feed.assistanceVersion ?? 0) + 1,
      assistanceConsentedAt: args.enabled ? Date.now() : undefined,
      assistanceBaselineRunId: baseline ? baseline._id : undefined,
      assistanceIssue: undefined,
    });
  },
});
/** Runs inside the snapshot publication transaction, before its previous snapshot is erased. */
export const observe = internalMutation({
  args: {
    feedId: v.id("calendarFeeds"),
    runId: v.id("calendarFeedRuns"),
    previousRunId: v.optional(v.id("calendarFeedRuns")),
  },
  handler: async (ctx, args): Promise<void> => {
    const feed = await ctx.db.get(args.feedId);
    if (
      !feed ||
      !feed.assistanceEnabled ||
      !feed.assistanceConsentedAt ||
      feed.publishedRunId !== args.runId ||
      !(await live(ctx, feed))
    )
      return;
    const current = await snapshot(ctx, feed, args.runId);
    if (!current || feed.assistanceBaselineRunId === current._id) return;
    const previous =
      feed.assistanceBaselineRunId === args.previousRunId
        ? await snapshot(ctx, feed, args.previousRunId)
        : null;
    await ctx.db.patch(feed._id, { assistanceBaselineRunId: current._id });
    const pending =
        feed.assistancePendingId &&
        (await ctx.db.get(feed.assistancePendingId)),
      queued =
        pending &&
        pending.status === "queued" &&
        pending.feedVersion === feed.version &&
        pending.assistanceVersion === (feed.assistanceVersion ?? 0) &&
        pending.expiresAt > Date.now()
          ? pending
          : null;
    if (!previous) {
      if (queued) await stop(ctx, feed, "A fresh calendar baseline is needed.");
      return;
    }
    const [before, after] = await Promise.all([
        events(ctx, previous._id),
        events(ctx, current._id),
      ]),
      latest = calendarChanges(before, after, previous, current),
      merged = mergeCalendarChanges(queued?.changes ?? [], latest);
    if (!merged.length) {
      if (queued)
        await stop(
          ctx,
          feed,
          "The calendar changes were undone before preparation.",
        );
      return;
    }
    const changes = merged.slice(0, calendarAssistanceLimits.changes),
      truncated = !!queued?.truncated || merged.length > changes.length,
      expiresAt = Math.min(
        current.expiresAt,
        (feed.lastCheckedAt ?? Date.now()) + calendarLimits.freshnessMs,
      ),
      version = (queued?.version ?? 0) + 1,
      notBefore =
        queued?.notBefore ?? Date.now() + calendarAssistanceLimits.debounceMs;
    let id: Id<"calendarAssistRuns">;
    const fields = {
      runId: current._id,
      version,
      changes,
      truncated,
      expiresAt,
    };
    if (queued) {
      id = queued._id;
      await ctx.db.patch(id, fields);
    } else
      id = await ctx.db.insert("calendarAssistRuns", {
        householdId: feed.householdId,
        createdBy: feed.createdBy,
        feedId: feed._id,
        feedVersion: feed.version,
        assistanceVersion: feed.assistanceVersion ?? 0,
        status: "queued",
        createdAt: Date.now(),
        notBefore,
        ...fields,
      });
    await ctx.db.patch(feed._id, {
      assistancePendingId: id,
      assistanceIssue: undefined,
    });
    await ctx.scheduler.runAfter(
      Math.max(0, notBefore - Date.now()),
      internal.calendarAssistance.prepare,
      { id, version },
    );
  },
});
export const prepare = internalMutation({
  args: { id: v.id("calendarAssistRuns"), version: v.number() },
  handler: async (ctx, args): Promise<Id<"jobs"> | null> => {
    const pending = await ctx.db.get(args.id);
    if (
      !pending ||
      pending.status !== "queued" ||
      pending.version !== args.version ||
      pending.notBefore > Date.now()
    )
      return null;
    const feed = await ctx.db.get(pending.feedId),
      current = feed ? await snapshot(ctx, feed, pending.runId) : null;
    const valid =
      feed &&
      feed.assistanceEnabled &&
      !!feed.assistanceConsentedAt &&
      feed.assistancePendingId === pending._id &&
      feed.version === pending.feedVersion &&
      (feed.assistanceVersion ?? 0) === pending.assistanceVersion &&
      feed.publishedRunId === pending.runId &&
      pending.expiresAt > Date.now() &&
      current &&
      (await live(ctx, feed));
    if (!valid || !configured()) {
      await ctx.db.patch(pending._id, {
        status: "cancelled",
        issue: !configured()
          ? "Assistant model setup changed."
          : "Calendar context or follow-up permission changed.",
      });
      return null;
    }
    const currentEvents = new Map(
      (await events(ctx, current._id)).map((e) => [calendarIdentity(e), e]),
    );
    for (const change of pending.changes) {
      const actual = currentEvents.get(change.key);
      if (
        change.after
          ? !actual || !sameCalendarMeaning(actual, change.after)
          : !!actual
      ) {
        await ctx.db.patch(pending._id, {
          status: "cancelled",
          issue: "The selected calendar event changed.",
        });
        return null;
      }
    }
    const changes = pending.changes.map((change, i) => ({
      sourceId: `calendar-change:${sourceHash(JSON.stringify([pending._id, change.key, i]))}`,
      text: calendarChangeEvidence(change).slice(
        0,
        calendarAssistanceLimits.text,
      ),
    }));
    const instruction =
      "Privately review the supplied changes to my selected calendar and prepare only useful household follow-ups for me to review. Consider up to ten changes; this is not an exhaustive calendar review. Stay quiet if no follow-up is useful. Do not share private event details, confirm facts, activate routines, send messages, book anything or change a calendar without separate exact review and approval.";
    const sourceId = await ctx.db.insert("sources", {
        householdId: feed.householdId,
        text: instruction,
        hash: `calendar-assistance:${pending._id}:${pending.version}`,
        revision: 1,
        expiresAt: pending.expiresAt,
      }),
      jobId = await ctx.db.insert("jobs", {
        householdId: feed.householdId,
        createdBy: feed.createdBy,
        sourceId,
        preparing: true,
        cancelled: false,
        interactive: true,
        conversation: true,
        clarification: "",
      });
    const started = await ctx.runMutation(internal.assistantCoordinator.start, {
      jobId,
      sourceRevision: 1,
      calendarContext: {
        feedId: feed._id,
        feedVersion: feed.version,
        runId: current._id,
        assistanceVersion: pending.assistanceVersion,
        changes,
      },
    });
    if (!started) {
      await ctx.db.patch(jobId, { preparing: false, cancelled: true });
      await ctx.db.patch(pending._id, {
        status: "failed",
        jobId,
        issue: "Calendar follow-ups could not start.",
      });
      return null;
    }
    await ctx.db.patch(pending._id, { status: "started", jobId });
    return jobId;
  },
});
export const cancel = internalMutation({
  args: { feedId: v.id("calendarFeeds") },
  handler: async (ctx, args) => {
    const feed = await ctx.db.get(args.feedId);
    if (feed)
      await stop(
        ctx,
        feed,
        "Calendar reading or follow-up permission changed.",
      );
  },
});
