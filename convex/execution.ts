import { pickupMailApprovalIssue } from './pickupMailRules'
import { routineJobIssue } from "./routineRules";
import { preserveNoticeContext } from "./assistantCoordinator";
import { canUse, providerOf, selection } from "./providerRules";
import { familyFactSchema, availabilityAt } from "../shared/memory";
import { queueNotice } from "./notifications";
import { checkedFiles } from "./emailFiles";
import { pickupDelivery } from "./pickupDelivery";
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import type { Id, Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { blockers, payloadHash, payloadSchema } from "../shared/daymark";
import {
  assertToolBudget,
  resolveApprovedTool,
  validateToolGrant,
} from "../shared/tools";

export async function validate(
  ctx: MutationCtx,
  a: Doc<"actions">,
  approval: Doc<"approvals">,
  options: { approvedPickupReminder?: boolean } = {},
) {
  if (approval.actionId !== a._id || approval.householdId !== a.householdId)
    return "This approval belongs to another action.";
  const job = await ctx.db.get(a.jobId),
    source = job && (await ctx.db.get(job.sourceId)),
    household = await ctx.db.get(a.householdId);
  const member = await ctx.db
    .query("memberships")
    .withIndex("by_subject", (q) => q.eq("subject", approval.subject))
    .unique();
  if (
    !job ||
    job.cancelled ||
    !household ||
    household.deleted ||
    member?.householdId !== a.householdId
  )
    return "This household or request is no longer active.";
  const routineIssue = await routineJobIssue(ctx, job);
  if (routineIssue) return routineIssue;
  if (
    !source ||
    source.revision !== approval.sourceRevision ||
    a.sourceRevision !== source.revision ||
    a.revision !== approval.revision ||
    a.approvalId !== approval._id ||
    payloadHash(a.payload) !== approval.payloadHash ||
    approval.expiresAt < Date.now()
  )
    return "The approval is stale. Review this action again.";
  try {
    await checkedFiles(ctx, a);
  } catch {
    return "An email attachment changed or expired. Review the files again.";
  }
  if (a.dependsOn) {
    const predecessor = await ctx.db.get(a.dependsOn);
    if (
      !predecessor ||
      predecessor.status !== "succeeded" ||
      predecessor.revision !== a.dependencyRevision
    )
      return "The caregiver arrangement changed. Review the calendar update again.";
  }
  const reviewedPayload = payloadSchema.parse(a.payload)
  // The parent already approved this exact reminder time. A scheduled reminder
  // becoming due does not invalidate the original invitation payload hash.
  if (options.approvedPickupReminder && reviewedPayload.kind === 'pickup' && approval.emailTransport === 'gmail' && typeof reviewedPayload.followUpAt === 'string' && approval.pickupEmail?.reminder?.at === reviewedPayload.followUpAt && Date.parse(reviewedPayload.followUpAt) <= Date.now()) delete reviewedPayload.followUpAt
  const issues = blockers(reviewedPayload, household.children);
  if (issues.length) return issues.join(" ");
  if (approval.connectionId) {
    const c = await ctx.db.get(approval.connectionId);
    if (
      !c ||
      c.subject !== approval.subject ||
      c.householdId !== household._id ||
      c.status !== "active" ||
      c.version !== approval.connectionVersion
    )
      return "Reconnect the approved account and review again.";
    const chosen = await selection(
      ctx,
      approval.subject,
      a.payload.kind === "calendar" ? "calendar" : "email",
    );
    if (
      chosen.version !== (approval.selectionVersion ?? 0) ||
      chosen.connection?._id !== c._id ||
      providerOf(c) !== (approval.provider ?? "google")
    )
      return "The selected account changed. Review this action again.";
    if (
      !canUse(c, a.payload.kind === "calendar" ? "calendar" : "email") ||
      (a.payload.kind === "calendar" &&
        c.calendarId !== approval.destination) ||
      (a.payload.kind === "email" && a.payload.to !== approval.destination)
    )
      return "The approved destination or permission changed.";
  }
  if (a.payload.kind === "pickup") {
    const mailIssue = await pickupMailApprovalIssue(ctx, a, approval)
    if (mailIssue) return mailIssue
    const facts = await ctx.db
      .query("memoryFacts")
      .withIndex("by_key", (q) => q.eq("householdId", household._id))
      .collect();
    const confirmed = facts
      .filter((f) => f.confirmed)
      .flatMap((f) => {
        const parsed = familyFactSchema.safeParse(f.value);
        return parsed.success ? [parsed.data] : [];
      });
    if (
      availabilityAt(
        confirmed,
        a.payload.caregiverId,
        a.payload.date,
        a.payload.time,
        a.payload.timezone,
        household.timezone,
      ) === "busy"
    )
      return "Caregiver availability changed. Choose another option.";
    const id = ctx.db.normalizeId("caregivers", a.payload.caregiverId),
      caregiver = id && (await ctx.db.get(id));
    if (
      !caregiver ||
      caregiver.householdId !== household._id ||
      caregiver.email !== approval.destination ||
      !caregiver.childIds.includes(a.payload.childId)
    )
      return "The caregiver or eligibility changed. Review again.";
    const delivery = await pickupDelivery(ctx, caregiver.email);
    if (
      delivery.channel !== (approval.deliveryChannel ?? "email") ||
      delivery.recipientSubject !== approval.recipientSubject
    )
      return "The caregiver delivery preference changed. Review this request again.";
  }
  if (
    a.payload.kind !== "calendar" &&
    process.env.DAYMARK_ENVIRONMENT !== "production" &&
    !(process.env.DAYMARK_TEST_EMAIL_RECIPIENTS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .includes(approval.destination.toLowerCase())
  )
    return "The test recipient allowlist changed. No email was sent.";
  try {
    const { tool } = resolveApprovedTool(a.payload, approval);
    const connection = approval.connectionId
      ? await ctx.db.get(approval.connectionId)
      : null;
    validateToolGrant(
      tool,
      connection,
      approval.destination,
      approval.nativeDeviceId,
    );
  } catch (error) {
    return error instanceof Error && error.name !== "ZodError"
      ? error.message
      : "This tool received unsupported action details. Review the request again.";
  }
  return null;
}
export const claim = internalMutation({
  args: { actionId: v.id("actions"), approvalId: v.id("approvals") },
  handler: async (ctx, args) => {
    const a = await ctx.db.get(args.actionId),
      approval = await ctx.db.get(args.approvalId);
    if (
      !a ||
      !approval ||
      a.status !== "queued" ||
      a.approvalId !== approval._id
    )
      return null;
    const reason = await validate(ctx, a, approval);
    if (reason) {
      await ctx.db.patch(a._id, {
        status: "review",
        error: reason,
        approvalId: undefined,
      });
      return null;
    }
    const { tool } = resolveApprovedTool(a.payload, approval);
    const previous = await ctx.db
      .query("attempts")
      .withIndex("by_action", (q) => q.eq("actionId", a._id))
      .collect();
    try {
      assertToolBudget(tool, {
        argumentBytes: new TextEncoder().encode(JSON.stringify(a.payload))
          .length,
        previousAttempts: previous.filter((t) => t.approvalId === approval._id)
          .length,
        adapterCalls: 1,
      });
    } catch {
      await ctx.db.patch(a._id, {
        status: "review",
        error:
          "This tool reached its execution limit. Review the request before trying again.",
        approvalId: undefined,
      });
      return null;
    }
    const attemptId = await ctx.db.insert("attempts", {
      householdId: a.householdId,
      toolName: tool.name,
      toolVersion: tool.version,
      actionId: a._id,
      approvalId: approval._id,
      dispatched: false,
      finished: false,
      startedAt: Date.now(),
    });
    await ctx.db.patch(a._id, { status: "executing", attemptId });
    await ctx.scheduler.runAfter(150_000, internal.execution.interrupted, {
      attemptId,
    });
    return { action: a, approval, attemptId };
  },
});
export const dispatch = internalMutation({
  args: { attemptId: v.id("attempts") },
  handler: async (ctx, { attemptId }) => {
    const attempt = await ctx.db.get(attemptId);
    if (!attempt || attempt.finished || attempt.dispatched) return false;
    const a = await ctx.db.get(attempt.actionId),
      approval = await ctx.db.get(attempt.approvalId);
    if (
      !a ||
      !approval ||
      a.attemptId !== attemptId ||
      a.status !== "executing"
    )
      return false;
    const reason = await validate(ctx, a, approval);
    if (reason) {
      await ctx.db.patch(a._id, {
        status: "review",
        error: reason,
        approvalId: undefined,
      });
      await ctx.db.patch(attemptId, { finished: true });
      return false;
    }
    await ctx.db.patch(attemptId, { dispatched: true });
    return true;
  },
});
/** Queue the read refresh in the same transaction as verified provider evidence. */
async function refreshCalendarSnapshot(
  ctx: MutationCtx,
  approval: Doc<"approvals">,
) {
  if (approval.connectionId)
    await ctx.scheduler.runAfter(0, internal.calendarFeeds.afterWrite, {
      connectionId: approval.connectionId,
      calendarId: approval.destination,
    });
}
export async function finishAttempt(
  ctx: MutationCtx,
  args: {
    attemptId: Id<"attempts">;
    status: "succeeded" | "failed" | "uncertain" | "review" | "waiting";
    error?: string;
    providerId?: string;
    outcome?:
      | "microsoft_accepted"
      | "apple_calendar_readback"
      | "apple_calendar_deleted";
    requestId?: string;
    etag?: string;
    url?: string;
  },
) {
  const attempt = await ctx.db.get(args.attemptId);
  if (!attempt || attempt.finished) return;
  const a = await ctx.db.get(attempt.actionId),
    approval = await ctx.db.get(attempt.approvalId);
  if (!a || !approval || a.attemptId !== attempt._id) return;
  if (
    args.outcome?.startsWith("apple_") &&
    (a.payload.kind !== "calendar" ||
      approval.provider !== "apple" ||
      args.outcome !==
        (a.payload.operation === "delete"
          ? "apple_calendar_deleted"
          : "apple_calendar_readback"))
  )
    throw new Error("Apple receipt does not match this approval.");
  if (
    args.outcome === "microsoft_accepted" &&
    (a.payload.kind !== "email" || approval.provider !== "microsoft")
  )
    throw new Error("Microsoft acceptance does not match this approval.");
  const acceptedMicrosoft =
    args.outcome === "microsoft_accepted" &&
    a.payload.kind === "email" &&
    approval.provider === "microsoft" &&
    args.status === "succeeded";
  if (
    ["succeeded", "waiting"].includes(args.status) &&
    (!attempt.dispatched || (!args.providerId && !acceptedMicrosoft))
  )
    throw new Error("A provider receipt is required.");
  const preserveContext = a.payload.kind === "calendar" && args.status === "succeeded"
    ? await preserveNoticeContext(ctx, a)
    : null;
  await ctx.db.patch(attempt._id, { finished: true });
  if (
    a.revision === approval.revision &&
    !(a.payload.kind === "pickup" && a.status === "succeeded")
  )
    await ctx.db.patch(a._id, { status: args.status, error: args.error });
  if (["failed", "uncertain", "review"].includes(args.status))
    await queueNotice(ctx, a.jobId, "help", String(a.sourceRevision));
  if (
    (args.providerId || acceptedMicrosoft) &&
    ["succeeded", "waiting"].includes(args.status)
  ) {
    await ctx.db.insert("receipts", {
      householdId: a.householdId,
      actionId: a._id,
      revision: approval.revision,
      ...(args.providerId ? { providerId: args.providerId } : {}),
      ...(args.requestId ? { requestId: args.requestId } : {}),
      outcome:
        args.outcome ??
        (a.payload.kind === "calendar"
          ? a.payload.operation === "delete"
            ? "calendar_deletion_verified"
            : "calendar_read_back_verified"
          : a.payload.kind === "email"
            ? "gmail_accepted"
            : approval.deliveryChannel === "app"
              ? "request_available_in_app"
              : "request_email_accepted"),
      verifiedAt: Date.now(),
      ...(args.url ? { url: args.url } : {}),
    });
    if (a.payload.kind === "calendar") {
      if (args.status === "succeeded")
        await refreshCalendarSnapshot(ctx, approval);
      if (a.payload.operation === "delete") {
        const target = ctx.db.normalizeId("planEvents", a.payload.targetId);
        if (target && (await ctx.db.get(target))) await ctx.db.delete(target);
        await preserveContext?.();
        return;
      }
      if (!args.etag)
        throw new Error("Calendar read-back must include an ETag.");
      const record = {
        ...(a.before?.external ? { external: true } : {}),
        householdId: a.householdId,
        owner: approval.subject,
        actionId: a._id,
        connectionId: approval.connectionId,
        connectionVersion: approval.connectionVersion,
        provider: approval.provider ?? "google",
        eventId: args.providerId!,
        calendarId: approval.destination,
        etag: args.etag,
        payload: { ...a.payload, evidence: {} },
        ...(args.url ? { url: args.url } : {}),
      };
      const target = a.payload.targetId
        ? ctx.db.normalizeId("planEvents", a.payload.targetId)
        : null;
      if (target) await ctx.db.patch(target, record);
      else {
        const old = await ctx.db
          .query("planEvents")
          .withIndex("by_action", (q) => q.eq("actionId", a._id))
          .unique();
        if (old) await ctx.db.patch(old._id, record);
        else await ctx.db.insert("planEvents", record);
      }
      await preserveContext?.();
    }
  }
}
export const finish = internalMutation({
  args: {
    attemptId: v.id("attempts"),
    status: v.union(
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("uncertain"),
      v.literal("review"),
      v.literal("waiting"),
    ),
    error: v.optional(v.string()),
    providerId: v.optional(v.string()),
    outcome: v.optional(
      v.union(
        v.literal("microsoft_accepted"),
        v.literal("apple_calendar_readback"),
        v.literal("apple_calendar_deleted"),
      ),
    ),
    requestId: v.optional(v.string()),
    etag: v.optional(v.string()),
    url: v.optional(v.string()),
  },
  handler: finishAttempt,
});
export const interrupted = internalMutation({
  args: { attemptId: v.id("attempts") },
  handler: async (ctx, { attemptId }) => {
    const attempt = await ctx.db.get(attemptId);
    if (!attempt || attempt.finished) return;
    const a = await ctx.db.get(attempt.actionId);
    if (!a || a.attemptId !== attemptId) return;
    if (a.payload.kind === "pickup" && a.status === "succeeded") {
      await ctx.db.patch(attemptId, { finished: true });
      return;
    }
    const approval = await ctx.db.get(attempt.approvalId);
    if (a.payload.kind === "pickup" && approval?.deliveryChannel === "app") {
      // In-app delivery commits its receipt and finishes the attempt atomically.
      // An unfinished attempt therefore cannot have delivered anything to the inbox.
      await ctx.db.patch(attemptId, { finished: true });
      await ctx.db.patch(a._id, {
        status: "failed",
        error:
          "The worker stopped before the request reached the caregiver’s inbox. Review to try again.",
      });
      await queueNotice(ctx, a.jobId, "help", String(a.sourceRevision));
      return;
    }
    await ctx.db.patch(a._id, {
      status: attempt.dispatched ? "uncertain" : "failed",
      error: attempt.dispatched
        ? "Execution was interrupted after dispatch. The result must be checked; this action will not be replayed automatically."
        : "Execution stopped before dispatch. Review to try again.",
    });
    await queueNotice(ctx, a.jobId, "help", String(a.sourceRevision));
    // Keep the attempt open so a late provider response may still record its evidence.
  },
});
export const failure = internalMutation({
  args: { actionId: v.id("actions"), approvalId: v.id("approvals") },
  handler: async (ctx, args) => {
    const a = await ctx.db.get(args.actionId);
    if (
      !a ||
      a.approvalId !== args.approvalId ||
      !["queued", "executing"].includes(a.status)
    )
      return;
    const attempt = a.attemptId && (await ctx.db.get(a.attemptId));
    const approval = await ctx.db.get(args.approvalId);
    if (a.payload.kind === "pickup" && approval?.deliveryChannel === "app") {
      if (attempt) await ctx.db.patch(attempt._id, { finished: true });
      await ctx.db.patch(a._id, {
        status: "failed",
        error:
          "The worker stopped before the request reached the caregiver’s inbox. Review to try again.",
      });
      await queueNotice(ctx, a.jobId, "help", String(a.sourceRevision));
      return;
    }
    await ctx.db.patch(a._id, {
      status: attempt && attempt.dispatched ? "uncertain" : "failed",
      error: "The worker stopped. No automatic send retry was made.",
    });
  },
});
export const snapshot = internalQuery({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    const a = await ctx.db.get(actionId);
    if (!a || !a.approvalId) return null;
    return { action: a, approval: await ctx.db.get(a.approvalId) };
  },
});
export const reconciled = internalMutation({
  args: {
    actionId: v.id("actions"),
    providerId: v.string(),
    etag: v.string(),
    url: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const a = await ctx.db.get(args.actionId);
    if (
      !a ||
      a.payload.kind !== "calendar" ||
      a.status !== "uncertain" ||
      !a.attemptId ||
      !a.approvalId
    )
      return;
    const approval = await ctx.db.get(a.approvalId);
    if (!approval) return;
    const preserveContext = await preserveNoticeContext(ctx, a);
    await ctx.db.patch(a.attemptId, { finished: true });
    await ctx.db.patch(a._id, { status: "succeeded", error: undefined });
    await ctx.db.insert("receipts", {
      householdId: a.householdId,
      actionId: a._id,
      revision: approval.revision,
      providerId: args.providerId,
      outcome:
        approval.provider === "apple"
          ? a.payload.operation === "delete"
            ? "apple_calendar_deleted"
            : "apple_calendar_readback"
          : a.payload.operation === "delete"
            ? "calendar_deletion_verified"
            : "calendar_read_back_verified",
      verifiedAt: Date.now(),
      ...(args.url ? { url: args.url } : {}),
    });
    await refreshCalendarSnapshot(ctx, approval);
    if (a.payload.operation === "delete") {
      const target = ctx.db.normalizeId("planEvents", a.payload.targetId);
      if (target && (await ctx.db.get(target))) await ctx.db.delete(target);
      await preserveContext?.();
      return;
    }
    const record = {
      ...(a.before?.external ? { external: true } : {}),
      householdId: a.householdId,
      owner: approval.subject,
      actionId: a._id,
      connectionId: approval.connectionId,
      connectionVersion: approval.connectionVersion,
      provider: approval.provider ?? "google",
      eventId: args.providerId!,
      calendarId: approval.destination,
      etag: args.etag,
      payload: { ...a.payload, evidence: {} },
      ...(args.url ? { url: args.url } : {}),
    };
    const target = a.payload.targetId
      ? ctx.db.normalizeId("planEvents", a.payload.targetId)
      : null;
    if (target) await ctx.db.patch(target, record);
    else {
      const old = await ctx.db
        .query("planEvents")
        .withIndex("by_action", (q) => q.eq("actionId", a._id))
        .unique();
      if (old) await ctx.db.patch(old._id, record);
      else await ctx.db.insert("planEvents", record);
    }
    await preserveContext?.();
  },
});
export const calendarMissing = internalMutation({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    const a = await ctx.db.get(actionId);
    if (
      !a ||
      a.status !== "uncertain" ||
      a.payload.kind !== "calendar" ||
      !a.attemptId
    )
      return;
    const attempt = await ctx.db.get(a.attemptId);
    if (!attempt || Date.now() - attempt.startedAt < 150_000) return;
    await ctx.db.patch(attempt._id, { finished: true });
    await ctx.db.patch(a._id, {
      status: a.before ? "review" : "failed",
      error: a.before
        ? "The original calendar event is missing. Review a new addition if needed."
        : "The calendar returned no event for this operation. Review to retry with the same operation identifier.",
    });
  },
});
export const defer = internalMutation({
  args: { attemptId: v.id("attempts") },
  handler: async (ctx, { attemptId }) => {
    const attempt = await ctx.db.get(attemptId);
    if (!attempt || attempt.dispatched || attempt.finished) return;
    const a = await ctx.db.get(attempt.actionId);
    if (!a || a.attemptId !== attemptId || a.status !== "executing") return;
    await ctx.db.patch(attemptId, { finished: true });
    const attempts = await ctx.db
      .query("attempts")
      .withIndex("by_action", (q) => q.eq("actionId", a._id))
      .collect();
    const count = attempts.filter(
      (t) => t.approvalId === attempt.approvalId,
    ).length;
    if (count >= 8) {
      await ctx.db.patch(a._id, {
        status: "failed",
        error:
          "The account stayed busy before dispatch. Review to try again; nothing was sent.",
      });
      return;
    }
    await ctx.db.patch(a._id, { status: "queued" });
    await ctx.scheduler.runAfter(
      Math.min(30_000, 1000 * 2 ** count),
      internal.tools.execute,
      { actionId: a._id, approvalId: attempt.approvalId },
    );
  },
});
