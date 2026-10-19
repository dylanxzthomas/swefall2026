import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";
import type { Id, Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { sourceHash } from "../shared/daymark";
import {
  mailboxRequestSchema,
  mailboxIntervalMs,
  mailboxRunLimit,
} from "../shared/mailbox";
import { createRun, mailboxIssue, runIssue } from "./mailbox";
type Ctx = Pick<QueryCtx, "db">;
const queueWaitMs = 5 * 60_000;
const requestArgs = {
  jobId: v.id("jobs"),
  sourceRevision: v.number(),
  query: v.string(),
  lookbackDays: v.number(),
};
const resultArgs = {
  jobId: v.id("jobs"),
  sourceRevision: v.number(),
  runId: v.id("mailRuns"),
  version: v.number(),
};
async function parentRequest(ctx: Ctx, jobId: Id<"jobs">, revision: number) {
  const job = await ctx.db.get(jobId),
    source = job && (await ctx.db.get(job.sourceId)),
    household = job && (await ctx.db.get(job.householdId)),
    member =
      job &&
      (await ctx.db
        .query("memberships")
        .withIndex("by_subject", (q) => q.eq("subject", job.createdBy))
        .unique());
  if (
    !job ||
    !job.interactive ||
    job.cancelled ||
    !job.preparing ||
    !source?.text ||
    source.revision !== revision ||
    source.expiresAt <= Date.now() ||
    !household ||
    household.deleted ||
    member?.householdId !== household._id
  )
    throw new ConvexError(
      "The saved assistant request changed or ended. Send a fresh request.",
    );
  return { job, source, household, hash: sourceHash(source.text) };
}
function busy(run: Doc<"mailRuns"> | null | undefined) {
  return (
    !!run &&
    (["queued", "running", "partial"].includes(run.status) ||
      (run.status === "failed" &&
        (run.consecutiveFailures ?? 0) < 6 &&
        !!run.nextAttemptAt))
  );
}
export type AssistantMailReference = { runId: Id<"mailRuns">; version: number };
export const request = internalMutation({
  args: requestArgs,
  handler: async (ctx, args): Promise<AssistantMailReference> => {
    const current = await parentRequest(ctx, args.jobId, args.sourceRevision),
      spec = mailboxRequestSchema.safeParse({
        kind: args.query.trim() ? "search" : "check",
        query: args.query,
        lookbackDays: args.lookbackDays,
      });
    if (!spec.success)
      throw new ConvexError(
        "Choose a bounded Gmail search of at most 300 characters and 1–3,650 days.",
      );
    const key = sourceHash(JSON.stringify(spec.data)),
      previous = await ctx.db
        .query("assistantMailRequests")
        .withIndex("by_request", (q) =>
          q
            .eq("jobId", args.jobId)
            .eq("sourceRevision", args.sourceRevision)
            .eq("key", key),
        )
        .unique();
    if (previous) {
      if (
        previous.createdBy !== current.job.createdBy ||
        previous.householdId !== current.job.householdId ||
        previous.sourceHash !== current.hash ||
        previous.expiresAt <= Date.now()
      )
        throw new ConvexError(
          "The saved email request changed. Start a fresh check.",
        );
      const run = await ctx.db.get(previous.runId);
      if (
        !run ||
        run.version !== previous.runVersion ||
        run.createdBy !== current.job.createdBy ||
        run.householdId !== current.job.householdId ||
        (await runIssue(ctx, run))
      )
        throw new ConvexError(
          "The private email request or access changed. Start a fresh check.",
        );
      return { runId: previous.runId, version: previous.runVersion };
    }
    const mailbox = await ctx.db
      .query("mailboxes")
      .withIndex("by_owner", (q) =>
        q
          .eq("householdId", current.job.householdId)
          .eq("createdBy", current.job.createdBy),
      )
      .order("desc")
      .first();
    if (!mailbox)
      throw new ConvexError(
        "Enable private Gmail assistance before asking me to read Gmail.",
      );
    const issue = await mailboxIssue(ctx, mailbox);
    if (issue) throw new ConvexError(issue);
    const active = mailbox.activeRunId
      ? await ctx.db.get(mailbox.activeRunId)
      : null;
    const compatible =
      active &&
      ["queued", "running"].includes(active.status) &&
      active.mode === "baseline" &&
      active.kind === spec.data.kind &&
      active.query === spec.data.query &&
      active.lookbackDays === spec.data.lookbackDays &&
      active.createdAt >= Date.now() - queueWaitMs &&
      !(await runIssue(ctx, active));
    let runId: Id<"mailRuns">, version: number;
    if (compatible) {
      runId = active._id;
      version = active.version;
    } else {
      const pending = await ctx.db
        .query("mailRuns")
        .withIndex("by_owner", (q) =>
          q
            .eq("householdId", current.job.householdId)
            .eq("createdBy", current.job.createdBy),
        )
        .order("desc")
        .take(30);
      if (
        pending.filter(
          (r) =>
            r.agentRequested &&
            r.status === "queued" &&
            r.createdAt > Date.now() - queueWaitMs,
        ).length >= 3
      )
        throw new ConvexError(
          "Several private email checks are already waiting. Let them finish first.",
        );
      runId = await createRun(
        ctx,
        mailbox,
        `assistant:${args.jobId}:${args.sourceRevision}:${key}`,
        spec.data,
        current.source.text!.slice(0, 2000),
        true,
        {
          jobId: args.jobId,
          sourceRevision: args.sourceRevision,
          sourceHash: current.hash,
          deferred: busy(active),
        },
      );
      const run = (await ctx.db.get(runId))!;
      version = run.version;
      await ctx.db.patch(runId, {
        expiresAt: Math.min(run.expiresAt, current.source.expiresAt),
      });
    }
    const run = (await ctx.db.get(runId))!;
    await ctx.db.insert("assistantMailRequests", {
      householdId: current.job.householdId,
      createdBy: current.job.createdBy,
      jobId: args.jobId,
      sourceRevision: args.sourceRevision,
      sourceHash: current.hash,
      key,
      runId,
      runVersion: version,
      createdAt: Date.now(),
      expiresAt: Math.min(current.source.expiresAt, run.expiresAt),
    });
    return { runId, version };
  },
});
export const activate = internalMutation({
  args: { id: v.id("mailRuns"), version: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const run = await ctx.db.get(args.id);
    if (
      !run ||
      !run.agentRequested ||
      run.version !== args.version ||
      run.status !== "queued"
    )
      return;
    const issue = await runIssue(ctx, run);
    if (issue) {
      await ctx.db.patch(run._id, {
        status: "cancelled",
        issue,
        hasMore: false,
      });
      return;
    }
    const mailbox = (await ctx.db.get(run.mailboxId))!;
    let active = mailbox.activeRunId
      ? await ctx.db.get(mailbox.activeRunId)
      : null;
    if (
      active &&
      active._id !== run._id &&
      busy(active) &&
      (await runIssue(ctx, active))
    ) {
      await ctx.db.patch(active._id, {
        status: "cancelled",
        version: active.version + 1,
        lease: undefined,
        leaseUntil: undefined,
        hasMore: false,
        issue: "The previous saved request or access changed.",
      });
      active = null;
    }
    if (active && active._id !== run._id && busy(active)) {
      if (Date.now() - run.createdAt >= queueWaitMs) {
        await ctx.db.patch(run._id, {
          status: "failed",
          hasMore: false,
          issue:
            "Another Gmail check is still open. This queued assistant check did not read messages; finish that check and ask again.",
        });
        return;
      }
      await ctx.scheduler.runAfter(
        10_000,
        internal.assistantMail.activate,
        args,
      );
      return;
    }
    await ctx.db.patch(mailbox._id, {
      activeRunId: run._id,
      nextCheckAt: Date.now() + mailboxIntervalMs,
      issue: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.gmailMailbox.check, args);
  },
});
export type AssistantMailResult = {
  ready: boolean;
  status: Doc<"mailRuns">["status"];
  runId: Id<"mailRuns">;
  version: number;
  coverage: string;
  messages: Array<{
    sourceId: Id<"mailMessages">;
    version: number;
    hash: string;
    text: string;
    sender: string;
    subject: string;
    receivedAt: number;
    extraction: Doc<"mailMessages">["extraction"];
    expiresAt: number;
  }>;
  issue?: string;
  expiresAt?: number;
};
export const result = internalQuery({
  args: resultArgs,
  handler: async (ctx, args): Promise<AssistantMailResult> => {
    const current = await parentRequest(ctx, args.jobId, args.sourceRevision),
      journal = await ctx.db
        .query("assistantMailRequests")
        .withIndex("by_job", (q) =>
          q.eq("jobId", args.jobId).eq("sourceRevision", args.sourceRevision),
        )
        .filter((q) => q.eq(q.field("runId"), args.runId))
        .first();
    const unavailable = (issue: string): AssistantMailResult => ({
      ready: true,
      status: "cancelled",
      runId: args.runId,
      version: args.version,
      coverage:
        "No current private Gmail evidence is available for this request.",
      messages: [],
      issue,
    });
    if (
      !journal ||
      journal.createdBy !== current.job.createdBy ||
      journal.householdId !== current.job.householdId ||
      journal.sourceHash !== current.hash ||
      journal.runVersion !== args.version ||
      journal.expiresAt <= Date.now()
    )
      return unavailable("The private email request changed or expired.");
    const run = await ctx.db.get(args.runId);
    if (
      !run ||
      run.version !== args.version ||
      run.householdId !== current.job.householdId ||
      run.createdBy !== current.job.createdBy
    )
      return unavailable("This Gmail check changed. Ask for a fresh check.");
    const issue = await runIssue(ctx, run);
    if (issue) return unavailable(issue);
    const ready =
      ["complete", "partial", "cancelled"].includes(run.status) ||
      (run.status === "failed" &&
        (!(run.consecutiveFailures ?? 0) ||
          (run.consecutiveFailures ?? 0) >= 6 ||
          !run.nextAttemptAt));
    if (!ready)
      return {
        ready: false,
        status: run.status,
        runId: run._id,
        version: run.version,
        coverage:
          "The permitted Gmail check is still running. No completion is claimed.",
        messages: [],
      };
    const messages: AssistantMailResult["messages"] = [];
    for (const id of run.messageIds.slice(-20)) {
      const m = await ctx.db.get(id);
      if (
        !m ||
        m.householdId !== run.householdId ||
        m.createdBy !== run.createdBy ||
        m.mailboxId !== run.mailboxId ||
        m.connectionId !== run.connectionId ||
        m.connectionVersion !== run.connectionVersion ||
        m.accountKey !== run.accountKey ||
        m.expiresAt <= Date.now() ||
        m.dismissed
      )
        continue;
      messages.push({
        sourceId: m._id,
        version: m.version,
        hash: m.contentHash,
        text: m.text.slice(0, 4000),
        sender: m.sender,
        subject: m.subject,
        receivedAt: m.receivedAt,
        extraction: {
          ...m.extraction,
          ...(m.text.length > 4000
            ? {
                truncated: true,
                incomplete: true,
                issues: [
                  ...m.extraction.issues.slice(0, 7),
                  "The assistant received only the first 4,000 characters.",
                ],
              }
            : {}),
        },
        expiresAt: m.expiresAt,
      });
    }
    const scope = run.scope === "inbox" ? "Inbox" : "mailbox search",
      coverage = `${run.scanned} read attempts in the ${scope} window ${new Date(run.from).toISOString()}–${new Date(run.through).toISOString()}; ${messages.length} selected saved bodies supplied (up to 20, 4,000 characters each). ${run.status === "partial" || run.hasMore ? "Partial coverage; remaining results were not read." : run.status === "complete" ? "The requested provider pages completed." : "This check did not complete."} This does not establish that the entire inbox is clear. Attachments and linked pages require separate processing.`;
    return {
      ready: true,
      status: run.status,
      runId: run._id,
      version: run.version,
      coverage,
      messages,
      ...(run.issue ? { issue: run.issue } : {}),
      expiresAt: Math.min(
        run.expiresAt,
        journal.expiresAt,
        ...messages.map((m) => m.expiresAt),
      ),
    };
  },
});
