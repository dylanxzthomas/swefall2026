import { retainReviewedTask, retryEligible, validFollowthroughSummary, followthroughSummaryReads } from "./mailFollowthrough";
import { redactRoutineDecision } from "./mailRoutineRetention";
import { googleConnectionConfigured } from "./providerConfiguration";
import { compareValues, ConvexError, v } from "convex/values";
import { start } from "@convex-dev/workflow";
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { adult } from "./access";
import {
  emailExtraction,
  gmailReplyRouting,
  mailSourceReference,
  mailboxFailureData,
} from "./schema";
import { mailboxRetry } from "../shared/mailboxFailures";
import { gmailReplyRoutingSchema, gmailReplySubject } from "../shared/gmailReply";
import { sourceHash } from "../shared/daymark";
import { gmailReadScope } from "../shared/emailWatches";
import {
  gmailComposeScope,
  mailboxBatchSize,
  mailboxIntervalMs,
  mailboxRetentionMs,
  mailboxRequestSchema,
  mailboxRunLimit,
  privateMailSummarySchema,
  type MailboxRequest,
  type MailboxRun,
  type MailboxSettings,
  type PrivateMailMessage,
} from "../shared/mailbox";

const configured = () =>
  Boolean(process.env.ANTHROPIC_API_KEY && process.env.DAYMARK_MODEL);
const dayMs = 86400_000,
  dailyReadLimit = 1000;
const utcDay = () => Math.floor(Date.now() / dayMs);
const readsToday = (mailbox: Doc<"mailboxes">) =>
  mailbox.readDay === utcDay() ? (mailbox.dayReadCount ?? 0) : 0;
// Automatic checks hand every changed source to preparation before reading the next batch.
const automaticRun = (run: Doc<"mailRuns">) => !run.agentRequested && /^(poll|enable):/.test(run.requestId);
const preparationBatchSize = 20;
const leaseFields = {
  id: v.id("mailRuns"),
  version: v.number(),
  lease: v.string(),
};
const identity = { id: v.id("mailboxes"), version: v.number() };
const accountKey = (c: Doc<"connections">) =>
  sourceHash(JSON.stringify([c._id, c.email?.trim().toLowerCase()]));
type ReadCtx = Pick<QueryCtx, "db">;
type MessageReads = {
  get(id: Id<"mailMessages">): Promise<Doc<"mailMessages"> | null>;
  recent(): Promise<Doc<"mailMessages">[]>;
  agent(run: Doc<"mailRuns">): Promise<Doc<"mailAgents"> | null>;
  followthrough(run: Doc<"mailRuns">): Promise<boolean>;
};
function recentMessages(ctx: ReadCtx, householdId: Id<"households">, subject: string) {
  return ctx.db.query("mailMessages")
    .withIndex("by_owner", q => q.eq("householdId", householdId).eq("createdBy", subject))
    .order("desc").take(100);
}
/** One query snapshot only: never retain private sources between requests. */
function messageReads(ctx: ReadCtx, householdId: Id<"households">, subject: string): MessageReads {
  const rows = new Map<Id<"mailMessages">, Promise<Doc<"mailMessages"> | null>>();
  const agents = new Map<string, Promise<Doc<"mailAgents"> | null>>();
  const followthrough = followthroughSummaryReads(ctx);
  const agent = (run: Doc<"mailRuns">) => {
    const key = `${run._id}:${run.version}`;
    if (!agents.has(key)) agents.set(key, ctx.db.query("mailAgents").withIndex("by_run", q => q.eq("runId", run._id).eq("runVersion", run.version)).unique());
    return agents.get(key)!;
  };
  let recent: Promise<Doc<"mailMessages">[]> | undefined;
  return {
    agent,
    async followthrough(run) { return followthrough(run, await agent(run)); },
    get(id) {
      if (!rows.has(id)) rows.set(id, ctx.db.get(id));
      return rows.get(id)!;
    },
    recent() {
      return recent ??= recentMessages(ctx, householdId, subject).then(messages => {
        for (const message of messages) rows.set(message._id, Promise.resolve(message));
        return messages;
      });
    },
  };
}
function preview(m: Doc<"mailMessages">): PrivateMailMessage {
  return {
    id: m._id,
    version: m.version,
    sender: m.sender,
    subject: m.subject,
    receivedAt: m.receivedAt,
    text: m.text,
    extraction: m.extraction,
    expiresAt: m.expiresAt,
    dismissed: m.dismissed,
  };
}

export async function mailboxIssue(
  ctx: ReadCtx,
  mailbox: Doc<"mailboxes">,
): Promise<string | null> {
  const household = await ctx.db.get(mailbox.householdId);
  const member = await ctx.db
    .query("memberships")
    .withIndex("by_subject", (q) => q.eq("subject", mailbox.createdBy))
    .unique();
  if (
    !household ||
    household.deleted ||
    member?.householdId !== mailbox.householdId
  )
    return "Household access changed. Reconnect your private mailbox.";
  const c = await ctx.db.get(mailbox.connectionId);
  if (
    !c ||
    !c.email?.trim() ||
    c.householdId !== mailbox.householdId ||
    c.subject !== mailbox.createdBy ||
    (c.provider ?? "google") !== "google" ||
    c.status !== "active" ||
    c.version !== mailbox.connectionVersion ||
    accountKey(c) !== mailbox.accountKey ||
    !c.scopes.includes(gmailReadScope)
  )
    return "Gmail reading access changed. Reconnect and explicitly resume your mailbox.";
  if (
    process.env.DAYMARK_ENVIRONMENT !== "production" &&
    !(process.env.DAYMARK_TEST_GOOGLE_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .includes(c.email?.toLowerCase() ?? "")
  )
    return "Use an explicitly allowlisted dedicated Gmail test account in this environment.";
  if (mailbox.state !== "active")
    return "Your private mailbox is paused or disconnected.";
  return null;
}
async function current(
  ctx: ReadCtx,
  householdId: Id<"households">,
  subject: string,
) {
  return ctx.db
    .query("mailboxes")
    .withIndex("by_owner", (q) =>
      q.eq("householdId", householdId).eq("createdBy", subject),
    )
    .order("desc")
    .first();
}
async function ownedMailbox(
  ctx: MutationCtx,
  id: Id<"mailboxes">,
  version: number,
) {
  const { household, subject } = await adult(ctx),
    mailbox = await ctx.db.get(id);
  if (
    !mailbox ||
    mailbox.householdId !== household._id ||
    mailbox.createdBy !== subject ||
    mailbox.state === "removed"
  )
    throw new ConvexError("This private mailbox is unavailable.");
  if (mailbox.version !== version)
    throw new ConvexError(
      "Mailbox settings changed. Reopen the current settings.",
    );
  return mailbox;
}
export async function privateMessage(
  ctx: QueryCtx | MutationCtx,
  id: Id<"mailMessages">,
  version?: number,
) {
  const { household, subject } = await adult(ctx),
    message = await ctx.db.get(id);
  if (
    !message ||
    message.householdId !== household._id ||
    message.createdBy !== subject ||
    message.expiresAt <= Date.now()
  )
    throw new ConvexError("This private email is unavailable or expired.");
  if (version !== undefined && message.version !== version)
    throw new ConvexError("This email changed. Reopen the current message.");
  const mailbox = await ctx.db.get(message.mailboxId);
  if (
    !mailbox ||
    mailbox.createdBy !== subject ||
    mailbox.householdId !== household._id ||
    mailbox.accountKey !== message.accountKey ||
    mailbox.connectionId !== message.connectionId ||
    mailbox.connectionVersion !== message.connectionVersion
  )
    throw new ConvexError(
      "The mailbox account changed. Check the email again.",
    );
  const issue = await mailboxIssue(ctx, mailbox);
  if (issue) throw new ConvexError(issue);
  return { household, subject, mailbox, message };
}
export async function runIssue(
  ctx: ReadCtx,
  run: Doc<"mailRuns">,
): Promise<string | null> {
  const mailbox = await ctx.db.get(run.mailboxId);
  if (
    !mailbox ||
    mailbox.householdId !== run.householdId ||
    mailbox.createdBy !== run.createdBy ||
    mailbox.version !== run.mailboxVersion ||
    mailbox.connectionId !== run.connectionId ||
    mailbox.connectionVersion !== run.connectionVersion ||
    mailbox.accountKey !== run.accountKey
  )
    return "Mailbox settings changed. Start a fresh check.";
  if (run.expiresAt <= Date.now())
    return "This private email check expired. Start a fresh check.";
  if (run.agentRequested) {
    const job = run.agentJobId ? await ctx.db.get(run.agentJobId) : null,
      source = job ? await ctx.db.get(job.sourceId) : null;
    if (
      !job ||
      !job.interactive ||
      job.cancelled ||
      !job.preparing ||
      job.householdId !== run.householdId ||
      job.createdBy !== run.createdBy ||
      !source ||
      source.revision !== run.agentSourceRevision ||
      source.expiresAt <= Date.now() ||
      sourceHash(source.text ?? "") !== run.agentSourceHash
    )
      return "The saved assistant request changed or ended. Start a fresh email check.";
  }
  return mailboxIssue(ctx, mailbox);
}
async function permittedRun(
  ctx: ReadCtx,
  args: { id: Id<"mailRuns">; version: number; lease: string },
) {
  const run = await ctx.db.get(args.id);
  return run &&
    run.version === args.version &&
    run.status === "running" &&
    run.lease === args.lease &&
    (run.leaseUntil ?? 0) > Date.now() &&
    !(await runIssue(ctx, run))
    ? run
    : null;
}
async function messageContext(
  ctx: ReadCtx,
  run: Doc<"mailRuns">,
  includeDismissed = false,
  reads?: MessageReads,
) {
  const rows = await Promise.all(
    run.messageIds.slice(-20).map((id) => reads ? reads.get(id) : ctx.db.get(id)),
  );
  return rows.filter((m): m is Doc<"mailMessages"> =>
    Boolean(
      m &&
      m.householdId === run.householdId &&
      m.createdBy === run.createdBy &&
      m.mailboxId === run.mailboxId &&
      m.accountKey === run.accountKey &&
      m.connectionId === run.connectionId &&
      m.connectionVersion === run.connectionVersion &&
      m.expiresAt > Date.now() &&
      (includeDismissed || !m.dismissed),
    ),
  );
}
async function summaryMessages(ctx: ReadCtx, run: Doc<"mailRuns">, reads?: MessageReads) {
  const fresh = await messageContext(ctx, run, false, reads);
  if (run.kind === "search" || automaticRun(run))
    return { messages: fresh, freshCount: fresh.length, cachedCount: 0 };
  const cached = (
    await (reads ? reads.recent() : recentMessages(ctx, run.householdId, run.createdBy))
  ).filter(
    (m) =>
      m.mailboxId === run.mailboxId &&
      m.accountKey === run.accountKey &&
      m.connectionId === run.connectionId &&
      m.connectionVersion === run.connectionVersion &&
      m.expiresAt > Date.now() &&
      !m.dismissed &&
      m.labels.includes("INBOX") &&
      !m.labels.some((label) => ["SPAM", "TRASH", "DRAFT"].includes(label)),
  );
  const selected = fresh.slice(-10);
  const ids = new Set(selected.map((m) => m._id));
  const older = cached
    .filter((m) => !ids.has(m._id))
    .slice(0, 20 - selected.length);
  const messages = [...selected, ...older],
    freshIds = new Set(fresh.map((m) => m._id));
  const freshCount = messages.filter((m) => freshIds.has(m._id)).length;
  return { messages, freshCount, cachedCount: messages.length - freshCount };
}
async function resumePreparedBatch(ctx: MutationCtx, run: Doc<"mailRuns">) {
  if (!automaticRun(run) || !["partial", "complete"].includes(run.status) || run.preparedVersion !== run.version || await runIssue(ctx, run)) return false;
  const mailbox = (await ctx.db.get(run.mailboxId))!;
  if (mailbox.activeRunId !== run._id) return false;
  if (run.status === "complete") {
    await ctx.db.patch(mailbox._id, { activeRunId: undefined, nextCheckAt: Date.now() + mailboxIntervalMs });
    return true;
  }
  if (readsToday(mailbox) >= dailyReadLimit) {
    await ctx.db.patch(mailbox._id, { nextCheckAt: (utcDay() + 1) * dayMs });
    return false;
  }
  const version = run.version + 1;
  await ctx.db.patch(run._id, {
    version, status: "queued", segmentScanned: 0, messageIds: [],
    preparedVersion: undefined, answer: undefined, coverage: undefined,
    evidence: undefined, summarySources: undefined, issue: undefined,
    lease: undefined, leaseUntil: undefined, nextAttemptAt: undefined,
  });
  await ctx.db.patch(mailbox._id, { nextCheckAt: Date.now() + mailboxIntervalMs });
  await ctx.scheduler.runAfter(0, internal.gmailMailbox.check, { id: run._id, version });
  return true;
}
export const resumePrepared = internalMutation({
  args: { id: v.id("mailRuns"), version: v.number() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.id);
    return !!run && run.version === args.version && await resumePreparedBatch(ctx, run);
  },
});
async function retireExpiredRun(ctx: MutationCtx, mailbox: Doc<"mailboxes">, run: Doc<"mailRuns">) {
  await ctx.db.patch(run._id, { status: "cancelled", version: run.version + 1,
    lease: undefined, leaseUntil: undefined, reservedReads: undefined, reservationDay: undefined,
    pageToken: undefined, pendingProviderIds: undefined, hasMore: false,
    issue: "This check expired before it finished. A fresh check uses the current permitted window." });
  if (mailbox.activeRunId === run._id) await ctx.db.patch(mailbox._id, { activeRunId: undefined, nextCheckAt: Date.now() });
}
async function stopRun(ctx: MutationCtx, mailbox: Doc<"mailboxes">) {
  const run = mailbox.activeRunId
    ? await ctx.db.get(mailbox.activeRunId)
    : null;
  if (run && !["complete", "cancelled"].includes(run.status))
    await ctx.db.patch(run._id, {
      status: "cancelled",
      version: run.version + 1,
      lease: undefined,
      leaseUntil: undefined,
      pageToken: undefined,
      pendingProviderIds: undefined,
      hasMore: false,
      issue: "This check stopped when mailbox settings changed.",
    });
}
export async function createRun(
  ctx: MutationCtx,
  mailbox: Doc<"mailboxes">,
  requestId: string,
  spec: MailboxRequest,
  request: string,
  forceBaseline = false,
  agent?: {
    jobId: Id<"jobs">;
    sourceRevision: number;
    sourceHash: string;
    deferred: boolean;
  },
): Promise<Id<"mailRuns">> {
  const now = Date.now(),
    mode =
      !forceBaseline &&
      spec.kind === "check" &&
      mailbox.historyId &&
      spec.lookbackDays === mailbox.lookbackDays
        ? ("history" as const)
        : ("baseline" as const);
  const id = await ctx.db.insert("mailRuns", {
    householdId: mailbox.householdId,
    createdBy: mailbox.createdBy,
    mailboxId: mailbox._id,
    mailboxVersion: mailbox.version,
    connectionId: mailbox.connectionId,
    connectionVersion: mailbox.connectionVersion,
    accountKey: mailbox.accountKey,
    requestId,
    requestHash: sourceHash(JSON.stringify([spec, request])),
    request,
    ...(agent
      ? {
          agentRequested: true,
          quiet: true,
          agentJobId: agent.jobId,
          agentSourceRevision: agent.sourceRevision,
          agentSourceHash: agent.sourceHash,
        }
      : {}),
    ...spec,
    mode,
    updateCheckpoint:
      spec.kind === "check" && (mode === "history" || !mailbox.historyId),
    scope: spec.kind === "check" ? "inbox" : "all_mail",
    status: "queued",
    version: 1,
    scanned: 0,
    segmentScanned: 0,
    from:
      mode === "history"
        ? (mailbox.lastCheckedAt ?? now - spec.lookbackDays * 86400_000)
        : Math.max(0, now - spec.lookbackDays * 86400_000),
    through: now,
    createdAt: now,
    expiresAt: now + mailboxRetentionMs,
    messageIds: [],
    ...(mode === "history" ? { historyId: mailbox.historyId } : {}),
    hasMore: true,
  });
  if (!agent?.deferred)
    await ctx.db.patch(mailbox._id, {
      activeRunId: id,
      nextCheckAt: now + mailboxIntervalMs,
      issue: undefined,
    });
  await ctx.scheduler.runAfter(
    0,
    agent?.deferred
      ? internal.assistantMail.activate
      : internal.gmailMailbox.check,
    { id, version: 1 },
  );
  return id;
}

export const settings = query({
  args: {},
  handler: async (ctx): Promise<MailboxSettings> => {
    const { household, subject } = await adult(ctx),
      mailbox = await current(ctx, household._id, subject);
    const c =
      mailbox && mailbox.state !== "removed"
        ? await ctx.db.get(mailbox.connectionId)
        : (
            await ctx.db
              .query("connections")
              .withIndex("by_subject", (q) => q.eq("subject", subject))
              .collect()
          ).find(
            (c) =>
              c.householdId === household._id &&
              (c.provider ?? "google") === "google",
          );
    const owned =
      c?.householdId === household._id && c.subject === subject ? c : null;
    return {
      configured: googleConnectionConfigured(),
      modelConfigured: configured(),
      connection: owned
        ? {
            id: owned._id,
            email: owned.email,
            version: owned.version,
            status: owned.status,
            revocationPending: owned.status === "revoked" && !!owned.cipher,
            readAllowed:
              owned.status === "active" &&
              owned.scopes.includes(gmailReadScope),
            composeAllowed:
              owned.status === "active" &&
              owned.scopes.includes(gmailComposeScope),
          }
        : null,
      mailbox: mailbox
        ? {
            id: mailbox._id,
            version: mailbox.version,
            connectionVersion: mailbox.connectionVersion,
            state: mailbox.state,
            lookbackDays: mailbox.lookbackDays,
            lastCheckedAt: mailbox.lastCheckedAt,
            nextCheckAt: mailbox.nextCheckAt,
            issue:
              mailbox.state === "active"
                ? ((await mailboxIssue(ctx, mailbox)) ?? mailbox.issue)
                : mailbox.issue,
          }
        : null,
    };
  },
});
export const messages = query({
  args: {},
  handler: async (ctx): Promise<PrivateMailMessage[]> => {
    const { household, subject } = await adult(ctx),
      mailbox = await current(ctx, household._id, subject);
    if (!mailbox || mailbox.state === "removed") return [];
    return (
      await ctx.db
        .query("mailMessages")
        .withIndex("by_owner", (q) =>
          q.eq("householdId", household._id).eq("createdBy", subject),
        )
        .order("desc")
        .take(100)
    )
      .filter(
        (m) =>
          m.mailboxId === mailbox._id &&
          m.accountKey === mailbox.accountKey &&
          m.expiresAt > Date.now(),
      )
      .slice(0, 30)
      .map(preview);
  },
});
export async function validMailSummary(
  ctx: Pick<QueryCtx, "db">,
  run: Doc<"mailRuns">,
  reads?: Pick<MessageReads, "get"> & Partial<Pick<MessageReads, "followthrough">>,
) {
  // Older summaries cannot prove which source versions their model saw. Keep
  // records intact, but never reuse that unbound text as current evidence.
  if (run.answer && run.summarySources === undefined) return false;
  if (!(await (reads?.followthrough ? reads.followthrough(run) : validFollowthroughSummary(ctx, run)))) return false;
  const refs = run.summarySources ?? [];
  if (
    refs.length > 20 ||
    new Set(refs.map((ref) => ref.id)).size !== refs.length
  )
    return false;
  const rows = await Promise.all(refs.map((ref) => reads ? reads.get(ref.id) : ctx.db.get(ref.id)));
  return rows.every(
    (m, i) =>
      m &&
      m.householdId === run.householdId &&
      m.createdBy === run.createdBy &&
      m.mailboxId === run.mailboxId &&
      m.accountKey === run.accountKey &&
      m.connectionId === run.connectionId &&
      m.connectionVersion === run.connectionVersion &&
      m.expiresAt > Date.now() &&
      !m.dismissed &&
      m.version === refs[i].version &&
      m.contentHash === refs[i].hash,
  );
}
export const runs = query({
  args: {},
  handler: async (ctx): Promise<MailboxRun[]> => {
    const { household, subject } = await adult(ctx);
    // Legacy visible runs omit quiet. Merge both indexed buckets so hidden
    // polling history never needs scanning and older visible work stays present.
    const buckets = await Promise.all([false, undefined].map(quiet => ctx.db
      .query("mailRuns")
      .withIndex("by_owner_quiet", q => q.eq("householdId", household._id).eq("createdBy", subject).eq("quiet", quiet))
      .order("desc").take(10)));
    const rows = buckets.flat().sort((a, b) =>
      compareValues(b._creationTime, a._creationTime) || compareValues(b._id, a._id)
    ).slice(0, 10);
    const reads = messageReads(ctx, household._id, subject);
    const result: MailboxRun[] = [];
    for (const run of rows) {
      const mailbox = await ctx.db.get(run.mailboxId);
      if (
        run.expiresAt <= Date.now() ||
        !mailbox ||
        mailbox.state === "removed"
      )
        continue;
      if (
        run.requestId.startsWith("poll:") &&
        run.scanned === 0 &&
        !run.issue &&
        ["queued", "running", "complete"].includes(run.status)
      )
        continue;
      if (run.kind === "check") await reads.recent();
      const sources = await messageContext(ctx, run, true, reads);
      if (run.kind === "check")
        for (const message of (await summaryMessages(ctx, run, reads)).messages)
          if (!sources.some((source) => source._id === message._id))
            sources.push(message);
      const staleSummary = !(await validMailSummary(ctx, run, reads));
      const agent = await reads.agent(run);
      result.push({
        ...(agent
          ? {
              followthrough: {
                status: agent.status,
                version: agent.version,
                retryable: await retryEligible(ctx, agent),
                ...(agent.status === "queued" &&
                agent.retryAfter &&
                agent.retryAfter > Date.now()
                  ? { retryAfter: agent.retryAfter }
                  : {}),
                ...(agent.issue ? { issue: agent.issue } : {}),
              },
            }
          : {}),
        id: run._id,
        version: run.version,
        request: run.request,
        kind: run.kind,
        status: run.status,
        scanned: run.scanned,
        from: run.from,
        through: run.through,
        scope: run.scope,
        answer: staleSummary
          ? "The source emails or saved work changed. Check Gmail again for an updated summary."
          : run.answer,
        coverage: run.coverage,
        issue: run.issue,
        hasMore: run.hasMore,
        canContinue: run.hasMore && ["partial", "failed"].includes(run.status) &&
          !(automaticRun(run) && run.status === "partial" && run.preparedVersion !== run.version && run.messageIds.length),
        createdAt: run.createdAt,
        messages: sources.map(preview),
        ...(run.lastFailure ? { lastFailure: run.lastFailure } : {}),
        ...(run.nextAttemptAt ? { nextAttemptAt: run.nextAttemptAt } : {}),
      });
    }
    return result;
  },
});
const refreshingConsent = "Gmail permission renewed. Refreshing the existing private mailbox; saved work is preserved.";
const refreshFields = {
  ...identity,
  connectionVersion: v.number(),
  cursor: v.optional(v.string()),
  resumeAt: v.optional(v.number()),
  issue: v.optional(v.string()),
};
type RefreshArgs = {
  id: Id<"mailboxes">; version: number; connectionVersion: number;
  cursor?: string; resumeAt?: number; issue?: string;
};
async function rebindCachedMessages(ctx: MutationCtx, args: RefreshArgs) {
  const mailbox = await ctx.db.get(args.id);
  // A pause, removal, second consent or access change cancels every queued batch.
  if (!mailbox || mailbox.version !== args.version || mailbox.connectionVersion !== args.connectionVersion ||
      mailbox.state !== "blocked" || mailbox.issue !== refreshingConsent ||
      await mailboxIssue(ctx, { ...mailbox, state: "active" })) return;
  const page = await ctx.db.query("mailMessages").withIndex("by_mailbox", q => q.eq("mailboxId", mailbox._id))
    .paginate({ cursor: args.cursor ?? null, numItems: 100 });
  for (const message of page.page) {
    if (message.householdId === mailbox.householdId && message.createdBy === mailbox.createdBy &&
        message.accountKey === mailbox.accountKey && message.connectionId === mailbox.connectionId &&
        message.connectionVersion < mailbox.connectionVersion && message.expiresAt > Date.now()) {
      // This is renewed access to the same cached evidence, not new source content.
      // Drafts, proposal bindings and approved operations deliberately are NOT rebound.
      await ctx.db.patch(message._id, { connectionVersion: mailbox.connectionVersion });
    }
  }
  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, internal.mailbox.refreshCachedConnection, { ...args, cursor: page.continueCursor });
    return;
  }
  await ctx.db.patch(mailbox._id, { state: "active", nextCheckAt: args.resumeAt, issue: args.issue });
  // Cron resumes preserved scans/cursors at their original backoff. Only a mailbox
  // with no unfinished scan starts a new check, from its existing history checkpoint.
  if (!mailbox.activeRunId && args.resumeAt !== undefined && args.resumeAt <= Date.now()) {
    await createRun(ctx, { ...mailbox, state: "active", nextCheckAt: args.resumeAt },
      `enable:${mailbox._id}:${mailbox.version}`, { kind: "check", query: "", lookbackDays: mailbox.lookbackDays }, "Check my inbox");
  }
}
export const refreshCachedConnection = internalMutation({
  args: refreshFields,
  handler: rebindCachedMessages,
});
async function refreshSameMailbox(ctx: MutationCtx, previous: Doc<"mailboxes">, connection: Doc<"connections">) {
  if (connection.version < previous.connectionVersion)
    throw new ConvexError("Gmail permission changed. Reconnect and review the current connection.");
  const version = previous.version + 1, now = Date.now();
  const run = previous.activeRunId ? await ctx.db.get(previous.activeRunId) : null;
  const resumable = run && !run.agentRequested && run.householdId === previous.householdId &&
    run.createdBy === previous.createdBy && run.mailboxId === previous._id &&
    run.connectionId === previous.connectionId && run.accountKey === previous.accountKey &&
    run.mailboxVersion === previous.version && run.connectionVersion === previous.connectionVersion &&
    run.expiresAt > now && (["queued", "running", "failed", "partial"].includes(run.status) ||
      run.status === "complete" && automaticRun(run) && run.preparedVersion !== run.version && run.messageIds.length > 0);
  let resumeAt = previous.nextCheckAt ?? now;
  if (resumable) {
    const abandoned = run.reservedReads ?? 0;
    await ctx.db.patch(run._id, {
      mailboxVersion: version, connectionVersion: connection.version, version: run.version + 1,
      status: run.status === "running" ? "queued" : run.status,
      scanned: run.scanned + abandoned, segmentScanned: run.segmentScanned + abandoned,
      reservedReads: undefined, reservationDay: undefined, lease: undefined, leaseUntil: undefined,
      // Re-run preparation only under the new explicit grant. Keep the original
      // scan window/cursors, failure count, retry time and charged read budget.
      preparedVersion: undefined, answer: undefined, coverage: undefined, evidence: undefined, summarySources: undefined,
    });
    resumeAt = Math.max(resumeAt, run.nextAttemptAt ?? 0);
  } else await stopRun(ctx, previous);
  const exhausted = resumable && (run.consecutiveFailures ?? 0) >= 6;
  const refreshed = { ...previous, version, connectionVersion: connection.version,
    state: "blocked" as const, issue: refreshingConsent, consentedAt: now,
    activeRunId: resumable ? run._id : undefined, nextCheckAt: undefined };
  const issue = await mailboxIssue(ctx, { ...refreshed, state: "active" });
  if (issue) throw new ConvexError(issue);
  await ctx.db.patch(previous._id, { version, connectionVersion: connection.version,
    state: "blocked", issue: refreshingConsent, consentedAt: now,
    activeRunId: refreshed.activeRunId, nextCheckAt: undefined });
  await rebindCachedMessages(ctx, { id: previous._id, version, connectionVersion: connection.version,
    ...(!exhausted ? { resumeAt } : {}),
    ...(resumable && run.issue ? { issue: run.issue } : {}) });
  return previous._id;
}
export const enable = mutation({
  args: {
    connectionId: v.id("connections"),
    connectionVersion: v.number(),
    lookbackDays: v.number(),
    consent: v.literal(true),
  },
  handler: async (ctx, args) => {
    const { household, subject } = await adult(ctx),
      spec = mailboxRequestSchema.safeParse({
        kind: "check",
        query: "",
        lookbackDays: args.lookbackDays,
      });
    if (!spec.success)
      throw new ConvexError(
        "Choose a recent mailbox window between one and 3,650 days.",
      );
    const c = await ctx.db.get(args.connectionId);
    if (
      !c ||
      !c.email?.trim() ||
      c.householdId !== household._id ||
      c.subject !== subject ||
      (c.provider ?? "google") !== "google" ||
      c.status !== "active" ||
      c.version !== args.connectionVersion ||
      !c.scopes.includes(gmailReadScope)
    )
      throw new ConvexError(
        "Connect your own Gmail with reading permission first.",
      );
    const previous = await current(ctx, household._id, subject);
    if (
      previous?.state === "active" &&
      previous.connectionId === c._id &&
      previous.connectionVersion === c.version &&
      previous.accountKey === accountKey(c) &&
      previous.lookbackDays === args.lookbackDays
    )
      return previous._id;
    // The broad grant is explicit and starts private. Previous shared scans stop; they
    // never silently inherit inbox-wide permission or ingest messages in parallel.
    for (const watch of await ctx.db
      .query("emailWatches")
      .withIndex("by_owner", (q) =>
        q.eq("householdId", household._id).eq("createdBy", subject),
      )
      .collect())
      if (watch.state !== "removed")
        await ctx.db.patch(watch._id, {
          state: "paused",
          version: watch.version + 1,
          lease: undefined,
          leaseUntil: undefined,
          nextCheckAt: undefined,
          pageToken: undefined,
          issue:
            "Selected-sender checks paused when private inbox assistance was enabled.",
        });
    if (previous && previous.state !== "removed" && previous.connectionId === c._id &&
        previous.accountKey === accountKey(c) && previous.lookbackDays === args.lookbackDays) {
      // Renewing/expanding a grant is not an account replacement or a deletion.
      return refreshSameMailbox(ctx, previous, c);
    }
    if (previous) {
      await stopRun(ctx, previous);
      await ctx.db.patch(previous._id, {
        state: "removed",
        version: previous.version + 1,
        nextCheckAt: undefined,
        activeRunId: undefined,
      });
      await ctx.scheduler.runAfter(0, internal.mailbox.eraseMailbox, {
        id: previous._id,
      });
    }
    const id = await ctx.db.insert("mailboxes", {
      householdId: household._id,
      createdBy: subject,
      connectionId: c._id,
      connectionVersion: c.version,
      accountKey: accountKey(c),
      readDay: utcDay(),
      dayReadCount: previous ? readsToday(previous) : 0,
      version: 1,
      state: "active",
      lookbackDays: args.lookbackDays,
      consentedAt: Date.now(),
      createdAt: Date.now(),
      nextCheckAt: Date.now(),
    });
    await createRun(
      ctx,
      (await ctx.db.get(id))!,
      `enable:${id}`,
      spec.data,
      "Check my inbox",
    );
    return id;
  },
});
export const setPaused = mutation({
  args: { ...identity, paused: v.boolean() },
  handler: async (ctx, args) => {
    const mailbox = await ownedMailbox(ctx, args.id, args.version);
    const c = await ctx.db.get(mailbox.connectionId);
    if (
      !args.paused &&
      (!c ||
        c.householdId !== mailbox.householdId ||
        c.subject !== mailbox.createdBy ||
        c.status !== "active" ||
        !c.scopes.includes(gmailReadScope) ||
        accountKey(c) !== mailbox.accountKey)
    )
      throw new ConvexError(
        "Reconnect the same Gmail account before resuming.",
      );
    if (!args.paused && c && c.version !== mailbox.connectionVersion) {
      await refreshSameMailbox(ctx, mailbox, c);
      return;
    }
    await stopRun(ctx, mailbox);
    await ctx.db.patch(mailbox._id, {
      state: args.paused ? "paused" : "active",
      version: mailbox.version + 1,
      connectionVersion: args.paused
        ? mailbox.connectionVersion
        : (c?.version ?? mailbox.connectionVersion),
      activeRunId: undefined,
      nextCheckAt: args.paused ? undefined : Date.now(),
      issue: undefined,
    });
  },
});
export const remove = mutation({
  args: identity,
  handler: async (ctx, args) => {
    const mailbox = await ownedMailbox(ctx, args.id, args.version);
    await stopRun(ctx, mailbox);
    await ctx.db.patch(mailbox._id, {
      state: "removed",
      version: mailbox.version + 1,
      activeRunId: undefined,
      nextCheckAt: undefined,
      historyId: undefined,
      issue: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.mailbox.eraseMailbox, {
      id: mailbox._id,
    });
  },
});
export const request = mutation({
  args: {
    requestId: v.string(),
    kind: v.union(v.literal("check"), v.literal("search")),
    query: v.string(),
    lookbackDays: v.number(),
    request: v.string(),
  },
  handler: async (ctx, args) => {
    const { household, subject } = await adult(ctx),
      spec = mailboxRequestSchema.safeParse({
        kind: args.kind,
        query: args.query,
        lookbackDays: args.lookbackDays,
      }),
      text = args.request.trim();
    if (
      !spec.success ||
      !args.requestId.trim() ||
      args.requestId.length > 200 ||
      !text ||
      text.length > 2000
    )
      throw new ConvexError(
        "Describe a mailbox check or search with a valid time window.",
      );
    const previous = await ctx.db
      .query("mailRuns")
      .withIndex("by_request", (q) =>
        q
          .eq("householdId", household._id)
          .eq("createdBy", subject)
          .eq("requestId", args.requestId),
      )
      .unique();
    if (previous) {
      if (
        previous.requestHash !== sourceHash(JSON.stringify([spec.data, text]))
      )
        throw new ConvexError(
          "This request was already used for a different mailbox check.",
        );
      return previous._id;
    }
    const mailbox = await current(ctx, household._id, subject);
    if (!mailbox)
      throw new ConvexError("Enable private Gmail assistance first.");
    const issue = await mailboxIssue(ctx, mailbox);
    if (issue) throw new ConvexError(issue);
    const active = mailbox.activeRunId
      ? await ctx.db.get(mailbox.activeRunId)
      : null;
    if (active && (["queued", "running", "partial"].includes(active.status) || automaticRun(active) && active.status === "complete" && active.preparedVersion !== active.version)) {
      const preparation = automaticRun(active) && ["partial", "complete"].includes(active.status)
        ? await ctx.db.query("mailAgents").withIndex("by_run", q => q.eq("runId", active._id).eq("runVersion", active.version)).unique()
        : null;
      if (!preparation || !["failed", "cancelled"].includes(preparation.status))
        throw new ConvexError("A mailbox check is already open. Continue or finish that check first.");
      // A deliberate fresh check can recover stale or exhausted preparation. Do
      // not silently reset its model budget or skip the sources in the background.
      await stopRun(ctx, mailbox);
      await ctx.db.patch(active._id, { ...(active.status === "complete" ? { status: "cancelled" as const, version: active.version + 1 } : {}), issue: "A new private check replaced this unfinished preparation." });
    }
    return createRun(ctx, mailbox, args.requestId, spec.data, text, true);
  },
});
export const continueRun = mutation({
  args: { id: v.id("mailRuns"), version: v.number() },
  handler: async (ctx, args) => {
    const { household, subject } = await adult(ctx),
      run = await ctx.db.get(args.id);
    if (!run || run.householdId !== household._id || run.createdBy !== subject)
      throw new ConvexError("This private email check is unavailable.");
    if (
      run.version !== args.version ||
      !["partial", "failed"].includes(run.status)
    )
      throw new ConvexError(
        "This email check changed. Reopen its latest status.",
      );
    const issue = await runIssue(ctx, run);
    if (issue) throw new ConvexError(issue);
    const mailbox = (await ctx.db.get(run.mailboxId))!,
      active = mailbox.activeRunId
        ? await ctx.db.get(mailbox.activeRunId)
        : null;
    if (
      active &&
      active._id !== run._id &&
      ["queued", "running", "partial"].includes(active.status)
    )
      throw new ConvexError("Finish the current mailbox check first.");
    if (automaticRun(run) && run.status === "partial" && run.preparedVersion !== run.version && run.messageIds.length)
      throw new ConvexError("Finish or retry preparation for these messages before continuing the check.");
    await ctx.db.patch(run._id, {
      status: "queued",
      version: run.version + 1,
      segmentScanned: 0,
      ...(automaticRun(run) && run.preparedVersion === run.version ? { messageIds: [] } : {}),
      preparedVersion: undefined,
      consecutiveFailures: 0,
      cursorResets: 0,
      answer: undefined,
      coverage: undefined,
      evidence: undefined,
      summarySources: undefined,
      issue: undefined,
      lease: undefined,
      leaseUntil: undefined,
      nextAttemptAt: undefined,
    });
    await ctx.db.patch(mailbox._id, {
      activeRunId: run._id,
      nextCheckAt: Date.now() + mailboxIntervalMs,
    });
    await ctx.scheduler.runAfter(0, internal.gmailMailbox.check, {
      id: run._id,
      version: run.version + 1,
    });
    return run._id;
  },
});
export const dismissMessage = mutation({
  args: {
    id: v.id("mailMessages"),
    version: v.number(),
    dismissed: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { message } = await privateMessage(ctx, args.id, args.version);
    if (
      args.dismissed &&
      (
        await ctx.db
          .query("mailDrafts")
          .withIndex("by_message", (q) => q.eq("messageId", message._id))
          .collect()
      ).some((draft) =>
        [
          "preparing",
          "saving",
          "uncertain",
          "sending",
          "send_uncertain",
        ].includes(draft.status),
      )
    )
      throw new ConvexError(
        "Resolve the active or uncertain reply draft before setting this email aside.",
      );
    if (message.dismissed !== args.dismissed)
      await ctx.db.patch(message._id, {
        dismissed: args.dismissed,
        version: message.version + 1,
      });
  },
});
export const shareMessage = mutation({
  args: {
    id: v.id("mailMessages"),
    version: v.number(),
    text: v.string(),
    consent: v.literal(true),
  },
  handler: async (ctx, args) => {
    const { message, household, subject } = await privateMessage(
        ctx,
        args.id,
        args.version,
      ),
      text = args.text.trim();
    if (!text || text.length > 20000)
      throw new ConvexError(
        "Review the exact text to share, up to 20,000 characters.",
      );
    const hash = sourceHash(text);
    if (message.sharedJobId && message.sharedVersion === args.version) {
      if (message.sharedHash !== hash)
        throw new ConvexError(
          "This version was already shared with different text. Review the shared request.",
        );
      return message.sharedJobId;
    }
    const sourceId = await ctx.db.insert("sources", {
      householdId: household._id,
      text,
      attachmentIds: [],
      hash: `shared-mail:${message._id}:${args.version}:${hash}`,
      revision: 1,
      expiresAt: Date.now() + mailboxRetentionMs,
    });
    const jobId = await ctx.db.insert("jobs", {
      householdId: household._id,
      sourceId,
      createdBy: subject,
      preparing: true,
      cancelled: false,
      clarification: "",
    });
    await ctx.db.patch(message._id, {
      sharedJobId: jobId,
      sharedVersion: args.version,
      sharedHash: hash,
    });
    await start(ctx, internal.workflows.prepare, { jobId, sourceRevision: 1 });
    return jobId;
  },
});

export const claim = internalMutation({
  args: leaseFields,
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.id),
      now = Date.now();
    if (
      !run ||
      run.version !== args.version ||
      !["queued", "running", "failed"].includes(run.status) ||
      (run.consecutiveFailures ?? 0) >= 6 ||
      (run.leaseUntil ?? 0) > now ||
      (run.nextAttemptAt ?? 0) > now
    )
      return null;
    if (run.expiresAt <= now) {
      const mailbox = await ctx.db.get(run.mailboxId);
      if (mailbox) await retireExpiredRun(ctx, mailbox, run);
      return null;
    }
    const issue = await runIssue(ctx, run);
    if (issue) {
      await ctx.db.patch(run._id, {
        status: "failed",
        issue,
        lease: undefined,
        leaseUntil: undefined,
      });
      return null;
    }
    const mailbox = (await ctx.db.get(run.mailboxId))!;
    if (mailbox.activeRunId !== run._id) return null;
    // An abandoned lease may have read its entire reservation. Count it rather than
    // letting interruptions or provider timeouts bypass either usage limit.
    const abandoned = run.reservedReads ?? 0,
      scanned = run.scanned + abandoned,
      segmentScanned = run.segmentScanned + abandoned,
      today = readsToday(mailbox);
    const maxReads = Math.min(
      mailboxBatchSize,
      mailboxRunLimit - segmentScanned,
      automaticRun(run) ? preparationBatchSize - run.messageIds.length : mailboxBatchSize,
      dailyReadLimit - today,
    );
    if (maxReads <= 0) {
      await ctx.db.patch(run._id, {
        status: "partial",
        scanned,
        segmentScanned,
        ...(automaticRun(run) && !run.messageIds.length ? { preparedVersion: run.version } : {}),
        reservedReads: undefined,
        reservationDay: undefined,
        hasMore: true,
        lease: undefined,
        leaseUntil: undefined,
        issue:
          today >= dailyReadLimit
            ? "The daily email reading limit was reached. Checking resumes tomorrow."
            : "This check continues in the next scheduled batch.",
      });
      await ctx.db.patch(mailbox._id, {
        ...(run.agentRequested ? { activeRunId: undefined } : {}),
        nextCheckAt:
          today >= dailyReadLimit
            ? (utcDay() + 1) * dayMs
            : now + mailboxIntervalMs,
      });
      if (automaticRun(run)) await ctx.scheduler.runAfter(0, internal.gmailMailbox.summarize, { id: run._id, version: run.version });
      return null;
    }
    await ctx.db.patch(run._id, {
      status: "running",
      scanned,
      segmentScanned,
      reservedReads: maxReads,
      reservationDay: utcDay(),
      lease: args.lease,
      leaseUntil: now + 120_000,
      nextAttemptAt: undefined,
    });
    await ctx.db.patch(mailbox._id, {
      readDay: utcDay(),
      dayReadCount: today + maxReads,
      nextCheckAt: now + mailboxIntervalMs,
    });
    return {
      run: { ...run, scanned, segmentScanned },
      mailbox,
      maxReads,
      accountEmail: (await ctx.db.get(run.connectionId))!
        .email!.trim()
        .toLowerCase(),
      connectionId: run.connectionId,
      connectionVersion: run.connectionVersion,
      request: {
        kind: run.kind,
        query: run.query,
        lookbackDays: run.lookbackDays,
      },
      from: run.from,
      through: run.through,
      pageToken: run.pageToken,
      historyId: run.historyId,
      baselineHistoryId: run.baselineHistoryId,
      pendingProviderIds: run.pendingProviderIds,
    };
  },
});
export const permitted = internalQuery({
  args: leaseFields,
  handler: async (ctx, args) => Boolean(await permittedRun(ctx, args)),
});
const providerMessage = v.object({
  providerId: v.string(),
  threadId: v.optional(v.string()),
  replyRouting: v.optional(gmailReplyRouting),
  sender: v.string(),
  subject: v.string(),
  receivedAt: v.number(),
  text: v.string(),
  extraction: emailExtraction,
  labels: v.array(v.string()),
});
export const finishBatch = internalMutation({
  args: {
    ...leaseFields,
    messages: v.array(providerMessage),
    removedIds: v.array(v.string()),
    processed: v.optional(v.number()),
    nextPageToken: v.optional(v.string()),
    pendingProviderIds: v.optional(v.array(v.string())),
    historyId: v.optional(v.string()),
    baselineHistoryId: v.optional(v.string()),
    partial: v.optional(v.boolean()),
    issue: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await permittedRun(ctx, args);
    if (!run) return false;
    const validId = (id: string) => Boolean(id.trim() && id.length <= 200),
      processed = args.processed ?? args.messages.length;
    if (
      !Number.isSafeInteger(processed) ||
      processed < args.messages.length ||
      processed > (run.reservedReads ?? mailboxBatchSize) ||
      run.segmentScanned + processed > mailboxRunLimit ||
      args.removedIds.length > 200 ||
      args.removedIds.some((id) => !validId(id)) ||
      (args.pendingProviderIds?.length ?? 0) > 200 ||
      args.pendingProviderIds?.some((id) => !validId(id)) ||
      (args.nextPageToken?.length ?? 0) > 2000 ||
      [args.historyId, args.baselineHistoryId].some(
        (id) => id !== undefined && !/^\d{1,100}$/.test(id),
      )
    )
      throw new ConvexError(
        "Mailbox worker returned invalid or oversized page details.",
      );
    if (
      new Set(args.messages.map((m) => m.providerId)).size !==
      args.messages.length
    )
      throw new ConvexError("Mailbox worker returned duplicate page messages.");
    const messageIds = [...run.messageIds];
    const removeId = async (providerId: string) => {
      const m = await ctx.db
        .query("mailMessages")
        .withIndex("by_message", (q) =>
          q
            .eq("householdId", run.householdId)
            .eq("createdBy", run.createdBy)
            .eq("accountKey", run.accountKey)
            .eq("providerId", providerId),
        )
        .unique();
      if (m) await ctx.db.delete(m._id);
    };
    for (const id of args.removedIds) await removeId(id);
    for (const m of args.messages) {
      if (
        !validId(m.providerId) ||
        (m.threadId !== undefined && !validId(m.threadId)) ||
        (m.replyRouting !== undefined && (!gmailReplyRoutingSchema.safeParse(m.replyRouting).success || m.replyRouting.threadId !== m.threadId || m.replyRouting.subject !== gmailReplySubject(m.subject))) ||
        !m.sender.trim() ||
        m.sender.length > 320 ||
        m.subject.length > 300 ||
        m.text.length > 16000 ||
        !Number.isSafeInteger(m.receivedAt) ||
        m.receivedAt < 0 ||
        m.receivedAt > Date.now() + 60_000 ||
        m.labels.length > 100 ||
        m.labels.some((label) => label.length > 100) ||
        m.extraction.issues.length > 8 ||
        m.extraction.issues.some((issue) => issue.length > 180)
      )
        throw new ConvexError(
          "Mailbox worker returned invalid message content.",
        );
      if (
        run.mode === "baseline" &&
        (m.receivedAt < run.from || m.receivedAt > run.through)
      )
        throw new ConvexError(
          "Mailbox message is outside the requested time window.",
        );
      if (
        m.labels.some((label) => ["SPAM", "TRASH", "DRAFT"].includes(label)) ||
        (run.kind === "check" && !m.labels.includes("INBOX"))
      ) {
        await removeId(m.providerId);
        continue;
      }
      const old = await ctx.db
        .query("mailMessages")
        .withIndex("by_message", (q) =>
          q
            .eq("householdId", run.householdId)
            .eq("createdBy", run.createdBy)
            .eq("accountKey", run.accountKey)
            .eq("providerId", m.providerId),
        )
        .unique();
      // Labels are mailbox state, not source evidence. Reading an email must not
      // invalidate its reviewed work or spend another model call. Preserve older
      // hashes too, so deployment does not manufacture a content correction.
      const content = ({ providerId, threadId, replyRouting, sender, subject, receivedAt, text, extraction }: typeof m) =>
        JSON.stringify({ providerId, threadId, replyRouting, sender, subject, receivedAt, text, extraction });
      const changed = !old || content(old) !== content(m) || old.connectionVersion !== run.connectionVersion || old.expiresAt <= Date.now();
      const contentHash = old && !changed ? old.contentHash : sourceHash(content(m));
      const fields = {
        ...m,
        householdId: run.householdId,
        createdBy: run.createdBy,
        mailboxId: run.mailboxId,
        connectionId: run.connectionId,
        connectionVersion: run.connectionVersion,
        accountKey: run.accountKey,
        contentHash,
        expiresAt: Date.now() + mailboxRetentionMs,
      };
      let id: Id<"mailMessages">;
      if (old) {
        id = old._id;
        await ctx.db.patch(id, {
          ...fields,
          replyRouting: m.replyRouting,
          version:
            old.version +
            (changed ? 1 : 0),
        });
      } else
        id = await ctx.db.insert("mailMessages", {
          ...fields,
          version: 1,
          dismissed: false,
        });
      if ((!automaticRun(run) || changed || old?.preparationHash !== contentHash) && !messageIds.includes(id)) messageIds.push(id);
    }
    const mailbox = (await ctx.db.get(run.mailboxId))!,
      refunded =
        mailbox.readDay === run.reservationDay
          ? Math.max(
              0,
              (mailbox.dayReadCount ?? 0) -
                Math.max(0, (run.reservedReads ?? processed) - processed),
            )
          : readsToday(mailbox);
    if (mailbox.readDay === run.reservationDay)
      await ctx.db.patch(mailbox._id, { dayReadCount: refunded });
    const pending = args.pendingProviderIds ?? [],
      more = Boolean(args.nextPageToken || pending.length || args.partial),
      scanned = run.scanned + processed,
      segmentScanned = run.segmentScanned + processed;
    const dailyExhausted =
      mailbox.readDay === utcDay() && refunded >= dailyReadLimit;
    const partial = Boolean(
        args.partial ||
        (more && (segmentScanned >= mailboxRunLimit || dailyExhausted || automaticRun(run) && messageIds.length >= preparationBatchSize)),
      ),
      status = partial
        ? ("partial" as const)
        : more
          ? ("queued" as const)
          : ("complete" as const);
    const resultHistoryId = args.historyId ?? run.resultHistoryId,
      baselineHistoryId = args.baselineHistoryId ?? run.baselineHistoryId;
    await ctx.db.patch(run._id, {
      status,
      scanned,
      consecutiveFailures: 0,
      quiet:
        Boolean(run.agentRequested) ||
        (run.requestId.startsWith("poll:") &&
          status === "complete" &&
          messageIds.length === 0 &&
          !run.recoveredHistory &&
          !args.issue),
      segmentScanned,
      preparedVersion: automaticRun(run) && !messageIds.length ? run.version : undefined,
      messageIds: messageIds.slice(-20),
      pageToken: args.nextPageToken,
      pendingProviderIds: pending.length ? pending : undefined,
      resultHistoryId,
      baselineHistoryId,
      hasMore: more,
      reservedReads: undefined,
      reservationDay: undefined,
      lease: undefined,
      leaseUntil: undefined,
      issue:
        dailyExhausted && more
          ? "The daily email reading limit was reached. Checking resumes tomorrow."
          : partial
            ? run.agentRequested
              ? "This assistant check stopped at its bounded reading limit. The remaining messages were not read."
              : automaticRun(run)
                ? "This check is partial. Sola prepares this batch before checking the remaining messages."
                : "This check is partial. It continues in the next scheduled batch, or you can continue now."
            : args.issue
              ? "Some message content could not be read completely. Check source coverage."
              : run.recoveredHistory
                ? "Gmail history expired; only the displayed recent window has been rechecked."
                : undefined,
    });
    if (status === "complete") {
      const historyId =
        run.mode === "history" ? resultHistoryId : baselineHistoryId;
      await ctx.db.patch(mailbox._id, {
        ...(automaticRun(run) ? {} : { activeRunId: undefined }),
        nextCheckAt: Date.now() + mailboxIntervalMs,
        ...(run.kind === "check" && run.updateCheckpoint !== false
          ? { lastCheckedAt: run.through, ...(historyId ? { historyId } : {}) }
          : {}),
        issue: undefined,
      });
    } else if (partial)
      await ctx.db.patch(mailbox._id, {
        ...(run.agentRequested ? { activeRunId: undefined } : {}),
        nextCheckAt: dailyExhausted
          ? (utcDay() + 1) * dayMs
          : Date.now() + mailboxIntervalMs,
      });
    if (status === "queued")
      await ctx.scheduler.runAfter(0, internal.gmailMailbox.check, {
        id: run._id,
        version: run.version,
      });
    else if (
      !run.agentRequested &&
      !(
        run.requestId.startsWith("poll:") &&
        status === "complete" &&
        messageIds.length === 0 &&
        !run.recoveredHistory &&
        !args.issue
      )
    )
      await ctx.scheduler.runAfter(0, internal.gmailMailbox.summarize, {
        id: run._id,
        version: run.version,
      });
    else if (automaticRun(run) && status === "complete" && !messageIds.length)
      await ctx.scheduler.runAfter(0, internal.mailbox.resumePrepared, { id: run._id, version: run.version });
    return true;
  },
});
export const summaryContext = internalQuery({
  args: { id: v.id("mailRuns"), version: v.number() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.id);
    if (
      !run ||
      run.version !== args.version ||
      !["complete", "partial"].includes(run.status) ||
      (await runIssue(ctx, run))
    )
      return null;
    return {
      run,
      mailbox: (await ctx.db.get(run.mailboxId))!,
      ...(await summaryMessages(ctx, run)),
    };
  },
});
export const finishSummary = internalMutation({
  args: {
    id: v.id("mailRuns"),
    version: v.number(),
    answer: v.string(),
    evidence: v.array(v.object({ messageId: v.string(), quote: v.string() })),
    sources: v.optional(v.array(mailSourceReference)),
    issue: v.optional(
      v.union(
        v.literal("model_unconfigured"),
        v.literal("model_failed"),
        v.literal("unverified"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.id);
    if (
      !run ||
      run.version !== args.version ||
      !["complete", "partial"].includes(run.status) ||
      (await runIssue(ctx, run))
    )
      return false;
    const parsed = privateMailSummarySchema.safeParse({
      answer: args.answer,
      evidence: args.evidence,
    });
    if (!parsed.success)
      throw new ConvexError(
        "The private email summary needs valid source references.",
      );
    const selection = await summaryMessages(ctx, run);
    let messages = selection.messages;
    if (!args.issue && messages.length && !args.sources?.length) return false;
    if (args.sources) {
      if (
        args.sources.length > 20 ||
        new Set(args.sources.map((s) => s.id)).size !== args.sources.length
      )
        return false;
      const rows = await Promise.all(args.sources.map((s) => ctx.db.get(s.id)));
      if (
        rows.some(
          (m, i) =>
            !m ||
            m.householdId !== run.householdId ||
            m.createdBy !== run.createdBy ||
            m.mailboxId !== run.mailboxId ||
            m.accountKey !== run.accountKey ||
            m.connectionId !== run.connectionId ||
            m.connectionVersion !== run.connectionVersion ||
            m.expiresAt <= Date.now() ||
            m.dismissed ||
            m.version !== args.sources![i].version ||
            m.contentHash !== args.sources![i].hash,
        )
      )
        return false;
      messages = rows as Doc<"mailMessages">[];
    }
    const freshCount = messages.filter((m) =>
        run.messageIds.includes(m._id),
      ).length,
      cachedCount = messages.length - freshCount;
    const evidence = parsed.data.evidence.filter((e) =>
      messages.some((m) => m._id === e.messageId && m.text.includes(e.quote)),
    );
    const grounded =
      (!messages.length && !args.evidence.length) ||
      (evidence.length === args.evidence.length && evidence.length > 0);
    const scope =
      run.scope === "inbox" ? "Inbox" : "mail search, including archived mail";
    const coverage = `${run.status === "partial" ? "Partial check" : "Checked"}: ${run.scanned} message reads attempted in ${scope}, ${new Date(run.from).toISOString().slice(0, 10)}–${new Date(run.through).toISOString().slice(0, 10)}. This summary uses ${messages.length} selected messages (${freshCount} from this check; ${cachedCount} previously saved), not the whole mailbox. Attachments and linked pages have not been read.${run.recoveredHistory ? " Earlier Gmail history expired; earlier coverage is incomplete." : ""}`;
    const explanation = !messages.length
      ? automaticRun(run)
        ? "No new or changed readable messages needed preparation in this batch. This does not establish that the whole mailbox is clear."
        : "There are no readable saved messages in this checked window. This does not establish that the whole mailbox is clear; attachments and linked pages were not read."
      : args.issue === "model_unconfigured"
        ? "Your messages were read privately, but AI summaries are not connected yet. Open the messages to review them."
        : args.issue === "model_failed"
          ? "The private email summary could not finish. Your saved messages are available to review."
          : args.issue === "unverified" || !grounded
            ? "I could not verify the summary against these messages. Review the source emails for details."
            : parsed.data.answer;
    const handled = !messages.length || args.issue === "model_unconfigured" || !args.issue && grounded;
    if (handled) for (const message of messages) await ctx.db.patch(message._id, { preparationHash: message.contentHash });
    await ctx.db.patch(run._id, {
      answer: explanation,
      coverage,
      evidence: grounded && !args.issue ? evidence : [],
      summarySources: messages.map((m) => ({
        id: m._id,
        version: m.version,
        hash: m.contentHash,
      })),
      expiresAt: Math.min(run.expiresAt, ...messages.map((m) => m.expiresAt)),
      preparedVersion: handled ? run.version : undefined,
    });
    if (automaticRun(run) && handled)
      await ctx.scheduler.runAfter(0, internal.mailbox.resumePrepared, { id: run._id, version: run.version });
    return true;
  },
});
export const resetCursor = internalMutation({
  args: { ...leaseFields, resetHistory: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const run = await permittedRun(ctx, args);
    if (!run) return false;
    const mailbox = (await ctx.db.get(run.mailboxId))!;
    if (mailbox.readDay === run.reservationDay)
      await ctx.db.patch(mailbox._id, {
        dayReadCount: Math.max(
          0,
          (mailbox.dayReadCount ?? 0) - (run.reservedReads ?? 0),
        ),
      });
    const cursorResets = (run.cursorResets ?? 0) + 1;
    if (cursorResets > 3) {
      await ctx.db.patch(run._id, { status: "failed", cursorResets, consecutiveFailures: 6,
        reservedReads: undefined, reservationDay: undefined, lease: undefined, leaseUntil: undefined,
        issue: "Gmail repeatedly returned an expired page. This check stopped; continue it to try again." });
      await ctx.db.patch(mailbox._id, { nextCheckAt: undefined });
      return true;
    }
    await ctx.db.patch(run._id, {
      status: "queued",
      cursorResets,
      pageToken: undefined,
      pendingProviderIds: undefined,
      resultHistoryId: undefined,
      ...(args.resetHistory
        ? {
            recoveredHistory: true,
            mode: "baseline",
            historyId: undefined,
            baselineHistoryId: undefined,
            from: Math.max(0, run.through - run.lookbackDays * 86400_000),
          }
        : {}),
      reservedReads: undefined,
      reservationDay: undefined,
      lease: undefined,
      leaseUntil: undefined,
      issue: args.resetHistory
        ? "Gmail history expired. Rechecking the displayed recent window; earlier coverage is incomplete."
        : "Gmail’s page expired. Restarting this window with duplicate protection.",
    });
    if (args.resetHistory)
      await ctx.db.patch(run.mailboxId, { historyId: undefined });
    await ctx.scheduler.runAfter(1000, internal.gmailMailbox.check, {
      id: run._id,
      version: run.version,
    });
    return true;
  },
});
export const failed = internalMutation({
  args: {
    ...leaseFields,
    reconnect: v.boolean(),
    failure: v.optional(mailboxFailureData),
    issue: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await permittedRun(ctx, args);
    if (!run) return false;
    const failure = args.reconnect
      ? {
          stage: args.failure?.stage ?? ("authorization" as const),
          code: "permission" as const,
          ...(args.failure?.status ? { status: args.failure.status } : {}),
        }
      : (args.failure ?? {
          stage: "authorization" as const,
          code: "unknown" as const,
        });
    if (
      failure.status !== undefined &&
      (!Number.isInteger(failure.status) ||
        failure.status < 100 ||
        failure.status > 599)
    )
      delete failure.status;
    const consecutiveFailures = (run.consecutiveFailures ?? 0) + 1,
      recovery = mailboxRetry(failure, consecutiveFailures, Date.now());
    await ctx.db.patch(run._id, {
      status: "failed",
      consecutiveFailures,
      lastFailure: { ...failure, at: Date.now() },
      scanned: run.scanned + (run.reservedReads ?? 0),
      segmentScanned: run.segmentScanned + (run.reservedReads ?? 0),
      reservedReads: undefined,
      reservationDay: undefined,
      lease: undefined,
      leaseUntil: undefined,
      issue: recovery.issue,
      nextAttemptAt: recovery.nextAttemptAt,
      hasMore: true,
    });
    await ctx.db.patch(run.mailboxId, {
      ...(recovery.blocked ? { state: "blocked" } : {}),
      nextCheckAt: recovery.nextAttemptAt,
      issue: recovery.issue,
    });
    return true;
  },
});
export const poll = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const mailbox of await ctx.db
      .query("mailboxes")
      .withIndex("by_due", (q) =>
        q
          .eq("state", "active")
          .gt("nextCheckAt", 0)
          .lte("nextCheckAt", Date.now()),
      )
      .take(20)) {
      const issue = await mailboxIssue(ctx, mailbox);
      if (issue) {
        await stopRun(ctx, mailbox);
        await ctx.db.patch(mailbox._id, {
          state: "blocked",
          nextCheckAt: undefined,
          issue,
        });
        continue;
      }
      const run = mailbox.activeRunId
        ? await ctx.db.get(mailbox.activeRunId)
        : null;
      if (run && run.expiresAt <= Date.now()) {
        await retireExpiredRun(ctx, mailbox, run);
        await createRun(ctx, { ...mailbox, activeRunId: undefined }, `poll:${mailbox._id}:${Date.now()}`, { kind: "check", query: "", lookbackDays: mailbox.lookbackDays }, "Check my inbox");
        continue;
      }
      if (run && ["queued", "running", "failed"].includes(run.status)) {
        if ((run.leaseUntil ?? 0) <= Date.now())
          await ctx.scheduler.runAfter(0, internal.gmailMailbox.check, {
            id: run._id,
            version: run.version,
          });
        continue;
      }
      if (run?.agentRequested && run.status === "partial") {
        await ctx.db.patch(mailbox._id, {
          activeRunId: undefined,
          nextCheckAt: Date.now() + mailboxIntervalMs,
        });
        continue;
      }
      if (run && automaticRun(run) && ["partial", "complete"].includes(run.status)) {
        if (!await resumePreparedBatch(ctx, run) && run.preparedVersion !== run.version) {
          const agent = await ctx.db.query("mailAgents").withIndex("by_run", q => q.eq("runId", run._id).eq("runVersion", run.version)).unique();
          if (!agent) await ctx.scheduler.runAfter(0, internal.gmailMailbox.summarize, { id: run._id, version: run.version });
          else if (["queued", "running"].includes(agent.status)) await ctx.scheduler.runAfter(0, internal.mailFollowthrough.recover, { id: agent._id });
          await ctx.db.patch(mailbox._id, { nextCheckAt: Date.now() + mailboxIntervalMs });
        }
        continue;
      }
      if (run?.status === "partial") {
        if (readsToday(mailbox) >= dailyReadLimit) {
          await ctx.db.patch(mailbox._id, {
            nextCheckAt: (utcDay() + 1) * dayMs,
          });
          continue;
        }
        await ctx.db.patch(run._id, {
          status: "queued",
          version: run.version + 1,
          segmentScanned: 0,
          answer: undefined,
          coverage: undefined,
          evidence: undefined,
          issue: undefined,
          lease: undefined,
          leaseUntil: undefined,
        });
        await ctx.db.patch(mailbox._id, {
          nextCheckAt: Date.now() + mailboxIntervalMs,
        });
        await ctx.scheduler.runAfter(0, internal.gmailMailbox.check, {
          id: run._id,
          version: run.version + 1,
        });
        continue;
      }
      await createRun(
        ctx,
        mailbox,
        `poll:${mailbox._id}:${Date.now()}`,
        { kind: "check", query: "", lookbackDays: mailbox.lookbackDays },
        "Check my inbox",
      );
    }
  },
});
export const eraseMailbox = internalMutation({
  args: { id: v.id("mailboxes") },
  handler: async (ctx, { id }) => {
    const mailbox = await ctx.db.get(id);
    if (!mailbox || mailbox.state !== "removed") return;
    const routineDecisions = await ctx.db.query("mailRoutineDecisions").withIndex("by_mailbox", q => q.eq("mailboxId", id)).take(100);
    for (const row of routineDecisions) await redactRoutineDecision(ctx, row);
    const messages = await ctx.db
      .query("mailMessages")
      .withIndex("by_mailbox", (q) => q.eq("mailboxId", id))
      .take(100);
    for (const message of messages) await ctx.db.delete(message._id);
    const drafts = await ctx.db
      .query("mailDrafts")
      .withIndex("by_mailbox", (q) => q.eq("mailboxId", id))
      .take(100);
    for (const draft of drafts) await ctx.db.delete(draft._id);
    const runs = await ctx.db
      .query("mailRuns")
      .withIndex("by_owner", (q) =>
        q
          .eq("householdId", mailbox.householdId)
          .eq("createdBy", mailbox.createdBy),
      )
      .filter((q) => q.eq(q.field("mailboxId"), id))
      .take(100);
    for (const run of runs) await ctx.db.delete(run._id);
    const conversations = await ctx.db
      .query("jobs")
      .withIndex("by_private_mail", (q) => q.eq("mailContext.mailboxId", id))
      .take(100);
    for (const job of conversations) {
      await ctx.db.patch(job._id, {
        mailContext: undefined,
        conversation: true,
        clarification:
          "This private email discussion was removed with its mailbox.",
      });
      const source = await ctx.db.get(job.sourceId);
      if (source)
        await ctx.db.patch(source._id, {
          text: undefined,
          attachmentIds: [],
          expiresAt: Date.now(),
        });
    }
    for (const table of ["mailAgents", "mailProposals"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_mailbox", (q) => q.eq("mailboxId", id))
        .take(100);
      for (const row of rows) {
        if ('input' in row) await retainReviewedTask(ctx, row);
        await ctx.db.delete(row._id);
      }
      if (rows.length === 100)
        await ctx.scheduler.runAfter(0, internal.mailbox.eraseMailbox, { id });
    }
    if (
      routineDecisions.length === 100 ||
      messages.length === 100 ||
      runs.length === 100 ||
      drafts.length === 100 ||
      conversations.length === 100
    )
      await ctx.scheduler.runAfter(0, internal.mailbox.eraseMailbox, { id });
  },
});
