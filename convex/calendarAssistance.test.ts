import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import workflow from "@convex-dev/workflow/test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import {
  googleCalendarReadScope,
  calendarLimits,
  type CalendarEvent,
} from "../shared/calendarAwareness";
import { calendarAssistanceLimits } from "../shared/calendarAssistance";
const modules = import.meta.glob("./**/*.ts"),
  now = Date.parse("2026-10-14T18:00Z");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-never-called");
  vi.stubEnv("DAYMARK_MODEL", "synthetic");
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
        status: "active",
        version: 1,
        scopes: [googleCalendarReadScope],
        email: "parent@example.test",
      }),
    ),
    feedId = await owner.mutation(api.calendarFeeds.save, {
      connectionId,
      connectionVersion: 1,
      calendars: [
        { id: "primary", name: "Private family calendar", timezone: "UTC" },
      ],
      consent: true,
    }),
    event: CalendarEvent = {
      providerId: "school-trip",
      calendarId: "primary",
      title: "Original private trip",
      location: "Private school location",
      start: now + 3600_000,
      end: now + 7200_000,
      allDay: false,
      timezone: "UTC",
      busy: true,
      recurring: false,
    };
  const publish = async (list: CalendarEvent[] = [event], omitted = 0) => {
    const runId = await t.run(async (ctx) => {
      const feed = (await ctx.db.get(feedId))!;
      if (feed.activeRunId) {
        const existing = await ctx.db.get(feed.activeRunId);
        if (existing?.status === "queued") return existing._id;
      }
      const id = await ctx.db.insert("calendarFeedRuns", {
        householdId,
        createdBy: "test|parent",
        feedId,
        feedVersion: feed.version,
        connectionVersion: 1,
        version: 1,
        status: "queued",
        from: now - 7 * 86400_000,
        through: now + 90 * 86400_000,
        calendarIndex: 0,
        pages: 0,
        eventCount: 0,
        omitted: 0,
        createdAt: Date.now(),
        expiresAt: Date.now() + calendarLimits.retentionMs,
      });
      await ctx.db.patch(feedId, { activeRunId: id });
      return id;
    });
    await t.mutation(internal.calendarFeeds.claim, {
      id: runId,
      version: 1,
      lease: "synthetic",
    });
    await t.mutation(internal.calendarFeeds.commitPage, {
      id: runId,
      version: 1,
      lease: "synthetic",
      events: list,
      omitted,
    });
    return runId;
  };
  const baseline = await publish(),
    enable = () =>
      owner.mutation(api.calendarAssistance.setEnabled, {
        feedId,
        feedVersion: 1,
        assistanceVersion: 0,
        enabled: true,
        consent: true,
      });
  const pending = () =>
    t.run(async (ctx) => {
      const feed = (await ctx.db.get(feedId))!;
      return feed.assistancePendingId
        ? ctx.db.get(feed.assistancePendingId)
        : null;
    });
  const prepare = async () => {
    const row = (await pending())!;
    return t.mutation(internal.calendarAssistance.prepare, {
      id: row._id,
      version: row.version,
    });
  };
  return {
    t,
    owner,
    other,
    householdId,
    connectionId,
    feedId,
    event,
    baseline,
    publish,
    enable,
    pending,
    prepare,
  };
}
it("defaults off, requires separate owner opt-in and never creates baseline or unchanged jobs", async () => {
  const f = await fixture();
  expect(
    (await f.owner.query(api.calendarFeeds.settings, {}))[0].assistanceEnabled,
  ).toBe(false);
  await f.publish([{ ...f.event, title: "Changed while disabled" }]);
  expect(await f.pending()).toBeNull();
  await expect(
    f.other.mutation(api.calendarAssistance.setEnabled, {
      feedId: f.feedId,
      feedVersion: 1,
      assistanceVersion: 0,
      enabled: true,
      consent: true,
    }),
  ).rejects.toThrow("unavailable");
  await expect(
    f.owner.mutation(api.calendarAssistance.setEnabled, {
      feedId: f.feedId,
      feedVersion: 1,
      assistanceVersion: 0,
      enabled: true,
    }),
  ).rejects.toThrow("Confirm");
  await f.enable();
  await f.publish([
    { ...f.event, title: "Changed while disabled", etag: "changed" },
  ]);
  expect(await f.pending()).toBeNull();
  for (const table of [
    "jobs",
    "assistantRuns",
    "actions",
    "approvals",
    "notifications",
  ] as const)
    expect(await f.t.run((ctx) => ctx.db.query(table).collect())).toEqual([]);
});
it("prepares meaningful private changes once after debounce with source content absent from the parent instruction", async () => {
  const f = await fixture();
  await f.enable();
  vi.setSystemTime(now + 1000);
  const runId = await f.publish([
      {
        ...f.event,
        title: "Changed private trip",
        location: "New private location",
      },
    ]),
    pending = (await f.pending())!;
  expect(pending.status).toBe("queued");
  expect(await f.prepare()).toBeNull();
  vi.setSystemTime(now + 1000 + calendarAssistanceLimits.debounceMs);
  const results = await Promise.all(
    Array.from({ length: 30 }, () => f.prepare()),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  const jobs = await f.t.run((ctx) => ctx.db.query("jobs").collect());
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({
    createdBy: "test|parent",
    interactive: true,
    conversation: true,
  });
  const source = (await f.t.run((ctx) => ctx.db.get(jobs[0].sourceId)))!;
  expect(source.text).not.toContain("Changed private trip");
  expect(source.text).not.toContain("New private location");
  const agent = (await f.t.run((ctx) =>
    ctx.db.query("assistantRuns").first(),
  ))!;
  expect(agent.refs).toContainEqual(
    expect.objectContaining({
      kind: "calendar",
      id: f.feedId,
      hash: runId,
      consentVersion: 1,
    }),
  );
  expect(agent.observations).toContain("Changed private trip");
  for (const table of [
    "actions",
    "approvals",
    "attempts",
    "receipts",
    "notifications",
  ] as const)
    expect(await f.t.run((ctx) => ctx.db.query(table).collect())).toEqual([]);
  expect(await f.other.query(api.assistantCoordinator.list, {})).toEqual([]);
}, 20_000);
it("coalesces rapid changes to the latest result and cancels changes undone before preparation", async () => {
  const f = await fixture();
  await f.enable();
  vi.setSystemTime(now + 1000);
  await f.publish([{ ...f.event, title: "First change" }]);
  const first = (await f.pending())!;
  vi.setSystemTime(now + 2000);
  await f.publish([{ ...f.event, title: "Latest change" }]);
  const second = (await f.pending())!;
  expect(second._id).toBe(first._id);
  expect(second.version).toBe(2);
  expect(second.changes).toMatchObject([
    {
      before: { title: "Original private trip" },
      after: { title: "Latest change" },
    },
  ]);
  vi.setSystemTime(now + 3000);
  await f.publish([f.event]);
  expect(await f.pending()).toBeNull();
  expect((await f.t.run((ctx) => ctx.db.get(first._id)))?.status).toBe(
    "cancelled",
  );
  expect(await f.t.run((ctx) => ctx.db.query("jobs").collect())).toEqual([]);
});
it("retargets a pending change onto an unchanged fresh publication without creating another request or extending its debounce", async () => {
  const f = await fixture();
  await f.enable();
  await f.publish([{ ...f.event, title: "Updated trip" }]);
  const first = (await f.pending())!;
  vi.setSystemTime(now + 1000);
  const current = await f.publish([
      { ...f.event, title: "Updated trip", etag: "provider-metadata-only" },
    ]),
    second = (await f.pending())!;
  expect(second._id).toBe(first._id);
  expect(second.runId).toBe(current);
  expect(second.notBefore).toBe(first.notBefore);
  expect(
    await f.t.run((ctx) => ctx.db.query("calendarAssistRuns").collect()),
  ).toHaveLength(1);
  vi.setSystemTime(first.notBefore);
  expect(await f.prepare()).toBeTruthy();
});
it("stays quiet for partial reads and stale baselines, and recovers only from a new complete baseline", async () => {
  const f = await fixture();
  await f.enable();
  await f.publish([{ ...f.event, title: "Incomplete changes" }], 1);
  expect(await f.pending()).toBeNull();
  await f.publish([{ ...f.event, title: "Fresh new baseline" }]);
  expect(await f.pending()).toBeNull();
  vi.setSystemTime(now + calendarLimits.freshnessMs + 1);
  await f.publish([{ ...f.event, title: "Changes since old snapshot" }]);
  expect(await f.pending()).toBeNull();
  expect(
    await f.t.run((ctx) => ctx.db.query("assistantRuns").collect()),
  ).toEqual([]);
});
it("blocks queued preparation after opt-out, revoked access, missing model setup or source freshness expiry", async () => {
  for (const change of ["optout", "grant", "model", "expiry"] as const) {
    const f = await fixture();
    await f.enable();
    await f.publish([{ ...f.event, title: "Updated" }]);
    const pending = (await f.pending())!;
    if (change === "optout")
      await f.owner.mutation(api.calendarAssistance.setEnabled, {
        feedId: f.feedId,
        feedVersion: 1,
        assistanceVersion: 1,
        enabled: false,
      });
    if (change === "grant")
      await f.t.run((ctx) =>
        ctx.db.patch(f.connectionId, { version: 2, status: "revoked" }),
      );
    if (change === "model") vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.setSystemTime(
      change === "expiry"
        ? now + calendarLimits.freshnessMs + 1
        : pending.notBefore,
    );
    expect(
      await f.t.mutation(internal.calendarAssistance.prepare, {
        id: pending._id,
        version: pending.version,
      }),
    ).toBeNull();
    expect(
      await f.t.run((ctx) => ctx.db.query("assistantRuns").collect()),
    ).toEqual([]);
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-never-called");
    vi.setSystemTime(now);
  }
});
it("cancels a started private worker when reading is paused or proactive consent is withdrawn", async () => {
  const f = await fixture();
  await f.enable();
  await f.publish([{ ...f.event, title: "Updated" }]);
  const pending = (await f.pending())!;
  vi.setSystemTime(pending.notBefore);
  const jobId = (await f.prepare())!;
  await f.owner.mutation(api.calendarAssistance.setEnabled, {
    feedId: f.feedId,
    feedVersion: 1,
    assistanceVersion: 1,
    enabled: false,
  });
  expect((await f.t.run((ctx) => ctx.db.get(jobId)))?.cancelled).toBe(true);
  const agent = (await f.t.run((ctx) =>
    ctx.db.query("assistantRuns").first(),
  ))!;
  expect(
    await f.t.mutation(internal.assistantCoordinator.claim, {
      id: agent._id,
      version: agent.version,
      lease: "late",
    }),
  ).toBeNull();
});
it("cancels pending preparation when reading pauses, is removed, its selected calendars change, or a verified write requests refresh", async () => {
  for (const operation of [
    "pause",
    "remove",
    "reselect",
    "verified-write",
  ] as const) {
    const f = await fixture();
    await f.enable();
    await f.publish([{ ...f.event, title: "Updated" }]);
    const pending = (await f.pending())!;
    if (operation === "reselect") {
      await f.owner.mutation(api.calendarFeeds.save, {
        connectionId: f.connectionId,
        connectionVersion: 1,
        version: 1,
        calendars: [
          { id: "different", name: "Different calendar", timezone: "UTC" },
        ],
        consent: true,
      });
      expect(
        (await f.t.run((ctx) => ctx.db.get(f.feedId)))?.assistanceEnabled,
      ).toBe(false);
    } else if (operation === "verified-write")
      await f.t.mutation(internal.calendarFeeds.afterWrite, {
        connectionId: f.connectionId,
        calendarId: "primary",
      });
    else
      await f.owner.mutation(api.calendarFeeds.change, {
        id: f.feedId,
        version: 1,
        operation,
      });
    vi.setSystemTime(pending.notBefore);
    expect(
      await f.t.mutation(internal.calendarAssistance.prepare, {
        id: pending._id,
        version: pending.version,
      }),
    ).toBeNull();
    expect((await f.t.run((ctx) => ctx.db.get(pending._id)))?.status).toBe(
      "cancelled",
    );
    expect(
      await f.t.run((ctx) => ctx.db.query("assistantRuns").collect()),
    ).toEqual([]);
    vi.setSystemTime(now);
  }
});
it("caps supplied changes and reports incomplete selection without spending model calls on every event", async () => {
  const f = await fixture();
  await f.enable();
  await f.publish(
    Array.from({ length: 15 }, (_, i) => ({
      ...f.event,
      providerId: `new-${i}`,
      title: `New event ${i}`,
    })),
  );
  const pending = (await f.pending())!;
  expect(pending.changes).toHaveLength(calendarAssistanceLimits.changes);
  expect(pending.truncated).toBe(true);
  expect(
    await f.t.run((ctx) => ctx.db.query("assistantRuns").collect()),
  ).toEqual([]);
});
