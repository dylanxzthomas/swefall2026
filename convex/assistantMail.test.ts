import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import workflow from "@convex-dev/workflow/test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { gmailReadScope } from "../shared/emailWatches";
import { sourceHash } from "../shared/daymark";
import { mailboxIntervalMs } from "../shared/mailbox";
import type { Id } from "./_generated/dataModel";
const modules = import.meta.glob("./**/*.ts"),
  now = Date.parse("2026-10-14T18:00:00Z");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("DAYMARK_ENVIRONMENT", "development");
  vi.stubEnv("DAYMARK_TEST_GOOGLE_EMAILS", "parent@example.test");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
async function fixture() {
  const t = convexTest(schema, modules);
  workflow.register(t);
  const owner = t.withIdentity({
      subject: "parent",
      tokenIdentifier: "test|parent",
    }),
    other = t.withIdentity({ subject: "other", tokenIdentifier: "test|other" }),
    householdId = await owner.mutation(api.households.save, {
      timezone: "UTC",
      children: [],
    });
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      householdId,
      subject: "test|other",
      role: "adult",
    }),
  );
  const connectionId = await t.run((ctx) =>
      ctx.db.insert("connections", {
        householdId,
        subject: "test|parent",
        provider: "google",
        version: 1,
        status: "active",
        scopes: [gmailReadScope],
        email: "parent@example.test",
      }),
    ),
    accountKey = sourceHash(
      JSON.stringify([connectionId, "parent@example.test"]),
    ),
    mailboxId = await t.run((ctx) =>
      ctx.db.insert("mailboxes", {
        householdId,
        createdBy: "test|parent",
        connectionId,
        connectionVersion: 1,
        accountKey,
        version: 1,
        state: "active",
        lookbackDays: 30,
        consentedAt: now,
        createdAt: now,
      }),
    );
  const addJob = async (text = "Check my email for field trip updates.") =>
    t.run(async (ctx) => {
      const sourceId = await ctx.db.insert("sources", {
          householdId,
          text,
          revision: 1,
          hash: sourceHash(text),
          expiresAt: now + 86400_000,
        }),
        jobId = await ctx.db.insert("jobs", {
          householdId,
          createdBy: "test|parent",
          sourceId,
          preparing: true,
          cancelled: false,
          interactive: true,
          clarification: "",
        });
      return { sourceId, jobId };
    });
  const { jobId, sourceId } = await addJob(),
    request = (query = "field trip", id = jobId) =>
      t.mutation(internal.assistantMail.request, {
        jobId: id,
        sourceRevision: 1,
        query,
        lookbackDays: 30,
      }),
    result = (runId: Id<"mailRuns">, version = 1, id = jobId) =>
      t.query(internal.assistantMail.result, {
        jobId: id,
        sourceRevision: 1,
        runId,
        version,
      }),
    claim = (runId: Id<"mailRuns">, lease = "lease") =>
      t.mutation(internal.mailbox.claim, { id: runId, version: 1, lease });
  const message = {
    providerId: "synthetic-message",
    threadId: "synthetic-thread",
    sender: "school@example.test",
    subject: "Field trip",
    receivedAt: now - 1000,
    text: "Return the form by Friday.",
    extraction: {
      format: "plain" as const,
      truncated: false,
      incomplete: false,
      attachments: false,
      issues: [],
    },
    labels: ["INBOX"],
  };
  const finish = (runId: Id<"mailRuns">, lease = "lease", more = false) =>
    t.mutation(internal.mailbox.finishBatch, {
      id: runId,
      version: 1,
      lease,
      messages: [message],
      removedIds: [],
      processed: 1,
      ...(more ? { nextPageToken: "more" } : {}),
    });
  return {
    t,
    owner,
    other,
    householdId,
    connectionId,
    mailboxId,
    jobId,
    sourceId,
    addJob,
    request,
    result,
    claim,
    finish,
    message,
  };
}
it("coalesces 50 model read requests into one owner-bound journal and real Gmail scan without model duplication", async () => {
  const f = await fixture(),
    refs = await Promise.all(Array.from({ length: 50 }, () => f.request()));
  expect(new Set(refs.map((r) => r.runId)).size).toBe(1);
  const ref = refs[0],
    run = await f.t.run((ctx) => ctx.db.get(ref.runId));
  expect(run).toMatchObject({
    agentRequested: true,
    quiet: true,
    agentJobId: f.jobId,
    agentSourceRevision: 1,
    kind: "search",
    mode: "baseline",
    scope: "all_mail",
    status: "queued",
  });
  expect(await f.result(ref.runId)).toMatchObject({
    ready: false,
    messages: [],
  });
  await f.claim(ref.runId);
  await f.finish(ref.runId);
  const result = await f.result(ref.runId);
  expect(result).toMatchObject({
    ready: true,
    status: "complete",
    messages: [
      { text: "Return the form by Friday.", subject: "Field trip", version: 1 },
    ],
  });
  expect(result.coverage).toContain("1 read attempts");
  expect(result.coverage).toContain("does not establish");
  expect(await f.owner.query(api.mailbox.runs, {})).toEqual([]);
  expect(await f.other.query(api.mailbox.messages, {})).toEqual([]);
  for (const table of [
    "mailAgents",
    "mailProposals",
    "actions",
    "approvals",
    "attempts",
  ] as const)
    expect(await f.t.run((ctx) => ctx.db.query(table).collect())).toEqual([]);
  expect(
    await f.t.run((ctx) => ctx.db.query("assistantMailRequests").collect()),
  ).toHaveLength(1);
});
it("joins only a compatible recent same-owner baseline run and journals that join durably", async () => {
  const f = await fixture(),
    first = await f.request(),
    secondJob = await f.addJob("Find the field trip email.");
  const second = await f.request("field trip", secondJob.jobId);
  expect(second.runId).toBe(first.runId);
  await f.claim(first.runId);
  await f.finish(first.runId);
  expect((await f.request("field trip", secondJob.jobId)).runId).toBe(
    first.runId,
  );
  expect(
    (await f.result(first.runId, 1, secondJob.jobId)).messages,
  ).toHaveLength(1);
  expect(
    await f.t.run((ctx) => ctx.db.query("mailRuns").collect()),
  ).toHaveLength(1);
});
it("queues an incompatible search without replacing an active scan, then activates it once the first completes", async () => {
  const f = await fixture(),
    first = await f.request(),
    queued = await f.request("dentist");
  expect(queued.runId).not.toBe(first.runId);
  expect((await f.t.run((ctx) => ctx.db.get(f.mailboxId)))?.activeRunId).toBe(
    first.runId,
  );
  await f.t.mutation(internal.assistantMail.activate, {
    id: queued.runId,
    version: 1,
  });
  expect(await f.claim(queued.runId)).toBeNull();
  await f.claim(first.runId);
  await f.finish(first.runId);
  await f.t.mutation(internal.assistantMail.activate, {
    id: queued.runId,
    version: 1,
  });
  expect((await f.t.run((ctx) => ctx.db.get(f.mailboxId)))?.activeRunId).toBe(
    queued.runId,
  );
  expect(await f.claim(queued.runId)).not.toBeNull();
});
it("stops waiting after five minutes rather than scheduling an unbounded loop or reading concurrently", async () => {
  const f = await fixture(),
    first = await f.request(),
    queued = await f.request("dentist");
  vi.setSystemTime(now + 5 * 60_000 + 1);
  await f.t.mutation(internal.assistantMail.activate, {
    id: queued.runId,
    version: 1,
  });
  expect(await f.result(queued.runId)).toMatchObject({
    ready: true,
    status: "failed",
    messages: [],
  });
  expect((await f.t.run((ctx) => ctx.db.get(f.mailboxId)))?.activeRunId).toBe(
    first.runId,
  );
  expect((await f.t.run((ctx) => ctx.db.get(queued.runId)))?.scanned).toBe(0);
});
it("checks saved request revision, cancellation, membership, consent and connection before provider reads and commits", async () => {
  for (const change of [
    "source",
    "cancel",
    "membership",
    "pause",
    "grant",
  ] as const) {
    const f = await fixture(),
      ref = await f.request();
    await f.claim(ref.runId);
    if (change === "source")
      await f.t.run((ctx) =>
        ctx.db.patch(f.sourceId, { revision: 2, text: "Never mind." }),
      );
    if (change === "cancel")
      await f.t.run((ctx) => ctx.db.patch(f.jobId, { cancelled: true }));
    if (change === "membership")
      await f.t.run(async (ctx) => {
        const m = await ctx.db
          .query("memberships")
          .withIndex("by_subject", (q) => q.eq("subject", "test|parent"))
          .unique();
        await ctx.db.delete(m!._id);
      });
    if (change === "pause")
      await f.t.run((ctx) =>
        ctx.db.patch(f.mailboxId, { state: "paused", version: 2 }),
      );
    if (change === "grant")
      await f.t.run((ctx) =>
        ctx.db.patch(f.connectionId, { version: 2, status: "revoked" }),
      );
    expect(
      await f.t.query(internal.mailbox.permitted, {
        id: ref.runId,
        version: 1,
        lease: "lease",
      }),
    ).toBe(false);
    expect(await f.finish(ref.runId)).toBe(false);
    expect(
      await f.t.run((ctx) => ctx.db.query("mailMessages").collect()),
    ).toEqual([]);
  }
});
it("does not let a different job or a foreign adult reuse another request journal or source context", async () => {
  const f = await fixture(),
    ref = await f.request(),
    other = await f.addJob("Another request");
  expect(await f.result(ref.runId, 1, other.jobId)).toMatchObject({
    ready: true,
    status: "cancelled",
    messages: [],
  });
  await f.t.run((ctx) => ctx.db.patch(f.jobId, { createdBy: "test|other" }));
  await expect(f.request()).rejects.toThrow("changed");
  expect((await f.t.run((ctx) => ctx.db.get(ref.runId)))?.scanned).toBe(0);
});
it("stops at a 100-read segment and does not automatically continue or request a separate summary", async () => {
  const f = await fixture(),
    ref = await f.request();
  await f.t.run((ctx) =>
    ctx.db.patch(ref.runId, { segmentScanned: 99, scanned: 99 }),
  );
  await f.claim(ref.runId);
  await f.finish(ref.runId, "lease", true);
  expect(await f.result(ref.runId)).toMatchObject({
    ready: true,
    status: "partial",
    messages: [{ subject: "Field trip" }],
  });
  expect((await f.result(ref.runId)).coverage).toContain("Partial coverage");
  expect(
    (await f.t.run((ctx) => ctx.db.get(f.mailboxId)))?.activeRunId,
  ).toBeUndefined();
  await f.t.run((ctx) => ctx.db.patch(f.mailboxId, { nextCheckAt: now }));
  await f.t.mutation(internal.mailbox.poll, {});
  expect((await f.t.run((ctx) => ctx.db.get(ref.runId)))?.version).toBe(1);
  expect((await f.t.run((ctx) => ctx.db.get(ref.runId)))?.status).toBe(
    "partial",
  );
  expect(await f.t.run((ctx) => ctx.db.query("mailAgents").collect())).toEqual(
    [],
  );
});
it("bounds message context, marks truncation and excludes dismissed or expired private mail", async () => {
  const f = await fixture(),
    ref = await f.request();
  await f.claim(ref.runId);
  await f.t.mutation(internal.mailbox.finishBatch, {
    id: ref.runId,
    version: 1,
    lease: "lease",
    messages: [{ ...f.message, text: "x".repeat(8000) }],
    removedIds: [],
    processed: 1,
  });
  const result = await f.result(ref.runId);
  expect(result.messages[0].text).toHaveLength(4000);
  expect(result.messages[0].extraction).toMatchObject({
    truncated: true,
    incomplete: true,
  });
  const id = result.messages[0].sourceId;
  await f.t.run((ctx) => ctx.db.patch(id, { dismissed: true, version: 2 }));
  expect((await f.result(ref.runId)).messages).toEqual([]);
  vi.setSystemTime(now + 86400_000 + 1);
  await expect(f.result(ref.runId)).rejects.toThrow("changed or ended");
});
it("does not create a run without current private processing consent or for a malformed model query", async () => {
  const f = await fixture();
  await expect(
    f.t.mutation(internal.assistantMail.request, {
      jobId: f.jobId,
      sourceRevision: 1,
      query: "x".repeat(301),
      lookbackDays: 30,
    }),
  ).rejects.toThrow("bounded");
  await f.t.run((ctx) => ctx.db.patch(f.mailboxId, { state: "paused" }));
  await expect(f.request()).rejects.toThrow("paused");
  expect(await f.t.run((ctx) => ctx.db.query("mailRuns").collect())).toEqual(
    [],
  );
});
it("does not leave a cancelled earlier assistant request blocking the next queued read or permit its late commit", async () => {
  const f = await fixture(),
    first = await f.request();
  await f.claim(first.runId);
  const secondJob = await f.addJob("Read the dentist email."),
    queued = await f.request("dentist", secondJob.jobId);
  await f.t.run((ctx) => ctx.db.patch(f.jobId, { cancelled: true }));
  await f.t.mutation(internal.assistantMail.activate, {
    id: queued.runId,
    version: 1,
  });
  expect((await f.t.run((ctx) => ctx.db.get(first.runId)))?.status).toBe(
    "cancelled",
  );
  expect((await f.t.run((ctx) => ctx.db.get(f.mailboxId)))?.activeRunId).toBe(
    queued.runId,
  );
  expect(await f.finish(first.runId)).toBe(false);
  expect(await f.claim(queued.runId)).not.toBeNull();
});
