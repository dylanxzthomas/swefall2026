import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { payloadHash } from "../shared/daymark";
import { event } from "../tests/fixtures/calendar";
const modules = import.meta.glob("./**/*.ts");
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
async function fixture(
  provider: "google" | "microsoft" | "apple",
  operation: "save" | "delete" = "save",
) {
  const t = convexTest(schema, modules),
    owner = t.withIdentity({
      subject: "parent",
      tokenIdentifier: "test|parent",
    }),
    householdId = await owner.mutation(api.households.save, {
      timezone: "UTC",
      children: [],
    });
  const ids = await t.run(async (ctx) => {
    const sourceId = await ctx.db.insert("sources", {
        householdId,
        text: "Reviewed synthetic calendar change",
        revision: 1,
        hash: "test",
        expiresAt: Date.now() + 86400_000,
      }),
      jobId = await ctx.db.insert("jobs", {
        householdId,
        sourceId,
        createdBy: "test|parent",
        preparing: false,
        cancelled: false,
        clarification: "",
      }),
      connectionId = await ctx.db.insert("connections", {
        householdId,
        subject: "test|parent",
        provider,
        status: "active",
        version: 1,
        scopes: [],
        calendarId: "selected",
      }),
      actionId = await ctx.db.insert("actions", {
        householdId,
        jobId,
        sourceRevision: 1,
        revision: 1,
        status: "executing",
        payload: { ...event, operation },
      }),
      approvalId = await ctx.db.insert("approvals", {
        householdId,
        actionId,
        subject: "test|parent",
        revision: 1,
        sourceRevision: 1,
        payloadHash: payloadHash({ ...event, operation }),
        provider,
        connectionId,
        connectionVersion: 1,
        destination: "selected",
        expiresAt: Date.now() + 86400_000,
      }),
      attemptId = await ctx.db.insert("attempts", {
        householdId,
        actionId,
        approvalId,
        dispatched: true,
        finished: false,
        startedAt: Date.now(),
      });
    if (operation === "delete") {
      const targetId = await ctx.db.insert("planEvents", {
        householdId,
        owner: "test|parent",
        actionId,
        connectionId,
        provider,
        eventId: "event",
        calendarId: "selected",
        etag: "old",
        payload: event,
      });
      await ctx.db.patch(actionId, {
        payload: { ...event, operation, targetId },
      });
      await ctx.db.patch(approvalId, {
        payloadHash: payloadHash({ ...event, operation, targetId }),
      });
    }
    await ctx.db.patch(actionId, { attemptId, approvalId });
    return { actionId, attemptId, connectionId };
  });
  const scheduled = () =>
    t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (timer) => timer.name === "calendarFeeds:afterWrite",
      ),
    );
  return { t, ...ids, scheduled };
}
it("atomically requests one read refresh after each verified provider receipt including removal and repeated completion reports", async () => {
  for (const provider of ["google", "microsoft", "apple"] as const)
    for (const operation of ["save", "delete"] as const) {
      const f = await fixture(provider, operation),
        args = {
          attemptId: f.attemptId,
          status: "succeeded" as const,
          providerId: "event",
          etag: "new",
        };
      await f.t.mutation(internal.execution.finish, args);
      await f.t.mutation(internal.execution.finish, args);
      const timers = await f.scheduled();
      expect(timers).toHaveLength(1);
      expect(timers[0].args).toEqual([
        { connectionId: f.connectionId, calendarId: "selected" },
      ]);
      expect(
        await f.t.run((ctx) => ctx.db.query("receipts").collect()),
      ).toHaveLength(1);
    }
});
it("includes read-only reconciliation receipts and does not refresh failed or still uncertain writes", async () => {
  for (const provider of ["google", "microsoft", "apple"] as const)
    for (const operation of ["save", "delete"] as const) {
      const f = await fixture(provider, operation);
      await f.t.mutation(internal.execution.finish, {
        attemptId: f.attemptId,
        status: "uncertain",
        error: "Synthetic lost response",
      });
      expect(await f.scheduled()).toEqual([]);
      await f.t.mutation(internal.execution.reconciled, {
        actionId: f.actionId,
        providerId: "event",
        etag: "new",
      });
      await f.t.mutation(internal.execution.reconciled, {
        actionId: f.actionId,
        providerId: "event",
        etag: "new",
      });
      expect(await f.scheduled()).toHaveLength(1);
      expect(
        await f.t.run((ctx) => ctx.db.query("receipts").collect()),
      ).toHaveLength(1);
    }
});
it("rolls back receipt and refresh together when required read-back evidence is missing", async () => {
  const f = await fixture("google");
  await expect(
    f.t.mutation(internal.execution.finish, {
      attemptId: f.attemptId,
      status: "succeeded",
      providerId: "event",
    }),
  ).rejects.toThrow("ETag");
  expect(await f.scheduled()).toEqual([]);
  expect(await f.t.run((ctx) => ctx.db.query("receipts").collect())).toEqual(
    [],
  );
  expect((await f.t.run((ctx) => ctx.db.get(f.attemptId)))?.finished).toBe(
    false,
  );
});
