// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import workflow from "@convex-dev/workflow/test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { sourceHash } from "../shared/daymark";
import { gmailReadScope } from "../shared/emailWatches";
const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
}));
vi.mock("./google", () => ({
  withGoogle: async (
    _ctx: unknown,
    _ref: unknown,
    work: (auth: unknown) => unknown,
  ) => work({}),
  ConnectionBusy: class extends Error {},
}));
vi.mock("@googleapis/gmail", () => ({
  gmail: () => ({
    users: {
      getProfile: mocks.profile,
      messages: { list: mocks.list, get: mocks.get },
    },
  }),
}));
const modules = import.meta.glob("./**/*.ts"),
  now = Date.parse("2026-10-14T18:00Z");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("DAYMARK_ENVIRONMENT", "development");
  vi.stubEnv("DAYMARK_TEST_GOOGLE_EMAILS", "parent@example.test");
  mocks.profile
    .mockReset()
    .mockResolvedValue({
      data: { emailAddress: "parent@example.test", historyId: "123" },
    });
  mocks.list
    .mockReset()
    .mockResolvedValue({
      data: { messages: [{ id: "real-adapter-synthetic-message" }] },
    });
  const text = "Return the field trip form by Friday.";
  mocks.get.mockReset().mockResolvedValue({
    data: {
      id: "real-adapter-synthetic-message",
      threadId: "school-thread",
      internalDate: String(now - 1000),
      labelIds: ["INBOX"],
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "school@example.test" },
          { name: "Subject", value: "Field trip form" },
        ],
        body: {
          data: Buffer.from(text).toString("base64url"),
          size: Buffer.byteLength(text),
        },
      },
    },
  });
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
    householdId = await owner.mutation(api.households.save, {
      timezone: "UTC",
      children: [],
    }),
    connectionId = await t.run((ctx) =>
      ctx.db.insert("connections", {
        householdId,
        subject: "test|parent",
        provider: "google",
        version: 1,
        status: "active",
        scopes: [gmailReadScope],
        email: "parent@example.test",
      }),
    );
  await t.run((ctx) =>
    ctx.db.insert("mailboxes", {
      householdId,
      createdBy: "test|parent",
      connectionId,
      connectionVersion: 1,
      accountKey: sourceHash(
        JSON.stringify([connectionId, "parent@example.test"]),
      ),
      version: 1,
      state: "active",
      lookbackDays: 30,
      consentedAt: now,
      createdAt: now,
    }),
  );
  const sourceId = await t.run((ctx) =>
      ctx.db.insert("sources", {
        householdId,
        text: "Find my field trip email.",
        revision: 1,
        hash: "synthetic",
        expiresAt: now + 86400_000,
      }),
    ),
    jobId = await t.run((ctx) =>
      ctx.db.insert("jobs", {
        householdId,
        createdBy: "test|parent",
        sourceId,
        interactive: true,
        preparing: true,
        cancelled: false,
        clarification: "",
      }),
    ),
    ref = await t.mutation(internal.assistantMail.request, {
      jobId,
      sourceRevision: 1,
      query: "field trip",
      lookbackDays: 30,
    });
  return { t, sourceId, jobId, ref };
}
it("connects a model-selected fresh search through the actual Gmail adapter into owner-only durable evidence without a second model worker", async () => {
  const f = await fixture();
  await f.t.action(internal.gmailMailbox.check, {
    id: f.ref.runId,
    version: f.ref.version,
  });
  const result = await f.t.query(internal.assistantMail.result, {
    jobId: f.jobId,
    sourceRevision: 1,
    ...f.ref,
  });
  expect(result).toMatchObject({
    ready: true,
    status: "complete",
    messages: [
      {
        subject: "Field trip form",
        text: "Return the field trip form by Friday.",
      },
    ],
  });
  expect(mocks.list.mock.calls[0][0].q).toContain("(field trip)");
  expect(mocks.get).toHaveBeenCalledTimes(1);
  for (const table of [
    "mailAgents",
    "actions",
    "approvals",
    "attempts",
    "receipts",
  ] as const)
    expect(await f.t.run((ctx) => ctx.db.query(table).collect())).toEqual([]);
  expect(JSON.stringify(result)).not.toMatch(
    /access_token|refresh_token|cipher/,
  );
});
it("discards the provider response if the saved parent request is corrected during that network read", async () => {
  const f = await fixture(),
    response = await mocks.get();
  mocks.get.mockImplementationOnce(async () => {
    await f.t.run((ctx) =>
      ctx.db.patch(f.sourceId, {
        revision: 2,
        text: "Never mind, stop reading.",
      }),
    );
    return response;
  });
  await f.t.action(internal.gmailMailbox.check, {
    id: f.ref.runId,
    version: 1,
  });
  expect(
    await f.t.run((ctx) => ctx.db.query("mailMessages").collect()),
  ).toEqual([]);
  expect(await f.t.run((ctx) => ctx.db.query("mailAgents").collect())).toEqual(
    [],
  );
});
