import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import workflow from "@convex-dev/workflow/test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { calendarPlanStatus } from "../shared/calendarPlan";
import {
  calendarLimits,
  googleCalendarReadScope,
  type CalendarEvent,
} from "../shared/calendarAwareness";
const modules = import.meta.glob("./**/*.ts"),
  now = Date.parse("2026-10-14T12:00:00Z");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
async function fixture(provider: 'google' | 'microsoft' = 'google') {
  const t = convexTest(schema, modules);
  workflow.register(t);
  const owner = t.withIdentity({
      subject: "owner",
      tokenIdentifier: "test|owner",
    }),
    other = t.withIdentity({ subject: "other", tokenIdentifier: "test|other" });
  const householdId = await owner.mutation(api.households.save, {
    timezone: "America/Los_Angeles",
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
      subject: "test|owner",
      provider,
      status: "active",
      version: 1,
      scopes: [provider === 'google' ? googleCalendarReadScope : 'Calendars.Read'],
      email: "calendar@example.test",
    }),
  );
  const calendars = [
    { id: "primary", name: "Family", timezone: "America/Los_Angeles" },
  ];
  const save = () =>
    owner.mutation(api.calendarFeeds.save, {
      connectionId,
      connectionVersion: 1,
      calendars,
      consent: true,
    });
  const id = await save(),
    feed = (await t.run((ctx) => ctx.db.get(id)))!,
    runId = feed.activeRunId!;
  const event: CalendarEvent = {
    providerId: "event-1",
    calendarId: "primary",
    title: "School trip",
    location: "School",
    start: now + 3600_000,
    end: now + 7200_000,
    allDay: false,
    timezone: "UTC",
    busy: true,
    recurring: true,
    uid: "trip",
  };
  const claim = (version = 1, lease = "lease", r = runId) =>
    t.mutation(internal.calendarFeeds.claim, { id: r, version, lease });
  const page = (
    events = [event],
    version = 1,
    next?: string,
    lease = "lease",
    r = runId,
  ) =>
    t.mutation(internal.calendarFeeds.commitPage, {
      id: r,
      version,
      lease,
      events,
      omitted: 0,
      ...(next ? { next } : {}),
    });
  const agenda = () =>
    owner.query(api.calendarFeeds.agenda, {
      from: now,
      through: now + 86400_000,
    });
  return {
    t,
    owner,
    other,
    householdId,
    connectionId,
    id,
    runId,
    event,
    claim,
    page,
    agenda,
    calendars,
    save,
  };
}
it("requires optional processing consent and separate reading access; isolates adults and anonymous clients", async () => {
  const f = await fixture();
  await expect(
    f.owner.mutation(api.calendarFeeds.save, {
      connectionId: f.connectionId,
      connectionVersion: 1,
      calendars: f.calendars,
      consent: false,
      version: 1,
    }),
  ).rejects.toThrow("Confirm");
  await expect(f.t.query(api.calendarFeeds.settings, {})).rejects.toThrow(
    "Sign in",
  );
  expect(await f.other.query(api.calendarFeeds.settings, {})).toEqual([]);
  await expect(
    f.other.mutation(api.calendarFeeds.sync, { id: f.id, version: 1 }),
  ).rejects.toThrow("unavailable");
  await f.t.run((ctx) =>
    ctx.db.patch(f.connectionId, {
      scopes: ["https://www.googleapis.com/auth/calendar.app.created"],
    }),
  );
  expect(await f.claim()).toBeNull();
  expect(
    (await f.owner.query(api.calendarFeeds.settings, {}))[0].needsReconnect,
  ).toBe(true);
});
it("publishes only a complete paginated snapshot atomically and deduplicates repeated provider ids", async () => {
  const f = await fixture();
  await f.claim();
  await f.page([f.event], 1, "cursor");
  expect((await f.agenda()).events).toEqual([]);
  await f.claim(2);
  await f.page(
    [
      f.event,
      {
        ...f.event,
        providerId: "event-2",
        start: now + 9000_000,
        end: now + 10000_000,
      },
    ],
    2,
  );
  const snapshot = await f.agenda();
  expect(snapshot.events).toHaveLength(2);
  expect(snapshot.availabilityKnown).toBe(true);
  expect(snapshot.coverage[0].complete).toBe(true);
  const conflicts = await f.owner.query(api.calendarFeeds.conflicts, {
    start: now + 4000_000,
    end: now + 5000_000,
  });
  expect(conflicts.conflicts).toHaveLength(1);
  expect(conflicts.availabilityKnown).toBe(true);
});
it("coalesces simultaneous sync and lease claims, refuses late responses and recovers expired leases", async () => {
  const f = await fixture();
  expect(
    new Set(
      await Promise.all(
        Array.from({ length: 30 }, () =>
          f.owner.mutation(api.calendarFeeds.sync, { id: f.id, version: 1 }),
        ),
      ),
    ).size,
  ).toBe(1);
  const claims = await Promise.all(
    Array.from({ length: 30 }, (_, i) => f.claim(1, `lease-${i}`)),
  );
  expect(claims.filter(Boolean)).toHaveLength(1);
  vi.setSystemTime(now + calendarLimits.leaseMs + 1);
  expect(await f.claim(1, "replacement")).not.toBeNull();
  expect(await f.page([f.event], 1, undefined, "lease-0")).toBe(false);
  expect(await f.page([f.event], 1, undefined, "replacement")).toBe(true);
  expect((await f.agenda()).events).toHaveLength(1);
});
it("invalidates reads on revoked grants, lost household membership or changed selection", async () => {
  for (const change of ["grant", "membership", "selection"] as const) {
    const f = await fixture();
    await f.claim();
    if (change === "grant")
      await f.t.run((ctx) =>
        ctx.db.patch(f.connectionId, { version: 2, status: "revoked" }),
      );
    if (change === "membership")
      await f.t.run(async (ctx) => {
        const m = await ctx.db
          .query("memberships")
          .withIndex("by_subject", (q) => q.eq("subject", "test|owner"))
          .unique();
        await ctx.db.delete(m!._id);
      });
    if (change === "selection")
      await f.owner.mutation(api.calendarFeeds.save, {
        connectionId: f.connectionId,
        connectionVersion: 1,
        calendars: [{ ...f.calendars[0], id: "different" }],
        consent: true,
        version: 1,
      });
    expect(await f.page()).toBe(false);
  }
});
it("replaces external edits and cancellations only when the replacement snapshot completes", async () => {
  const f = await fixture();
  await f.claim();
  await f.page();
  vi.setSystemTime(now + 31_000);
  const second = await f.owner.mutation(api.calendarFeeds.sync, {
    id: f.id,
    version: 1,
  });
  await f.claim(1, "second", second);
  await f.page(
    [{ ...f.event, title: "New venue", location: "Museum" }],
    1,
    "more",
    "second",
    second,
  );
  expect((await f.agenda()).events[0].location).toBe("School");
  await f.claim(2, "second2", second);
  await f.page([], 2, undefined, "second2", second);
  expect((await f.agenda()).events[0].location).toBe("Museum");
  vi.setSystemTime(now + 62_000);
  const third = await f.owner.mutation(api.calendarFeeds.sync, {
    id: f.id,
    version: 1,
  });
  await f.claim(1, "third", third);
  await f.page([], 1, undefined, "third", third);
  expect((await f.agenda()).events).toEqual([]);
  expect((await f.agenda()).availabilityKnown).toBe(true);
});
it("does not promise availability when events are omitted, stale, partially read or paused", async () => {
  const f = await fixture();
  await f.claim();
  await f.t.mutation(internal.calendarFeeds.commitPage, {
    id: f.runId,
    version: 1,
    lease: "lease",
    events: [f.event],
    omitted: 1,
  });
  expect((await f.agenda()).availabilityKnown).toBe(false);
  expect((await f.agenda()).coverage[0].complete).toBe(false);
  vi.setSystemTime(now + calendarLimits.freshnessMs + 1);
  expect((await f.agenda()).coverage[0].fresh).toBe(false);
  await f.owner.mutation(api.calendarFeeds.change, {
    id: f.id,
    version: 1,
    operation: "pause",
  });
  expect((await f.agenda()).events).toEqual([]);
  await expect(
    f.owner.mutation(api.calendarFeeds.change, {
      id: f.id,
      version: 1,
      operation: "resume",
      consent: true,
    }),
  ).rejects.toThrow("changed");
  await expect(
    f.owner.mutation(api.calendarFeeds.change, {
      id: f.id,
      version: 2,
      operation: "resume",
    }),
  ).rejects.toThrow("Confirm");
});
it("hides removed feeds immediately and cleans private event text in bounded batches", async () => {
  const f = await fixture();
  await f.claim();
  await f.page();
  await f.owner.mutation(api.calendarFeeds.change, {
    id: f.id,
    version: 1,
    operation: "remove",
  });
  expect((await f.agenda()).events).toEqual([]);
  expect(await f.owner.query(api.calendarFeeds.settings, {})).toEqual([]);
  await f.t.mutation(internal.calendarFeeds.cleanupRun, { id: f.runId });
  expect(
    await f.t.run((ctx) => ctx.db.query("calendarFeedEvents").collect()),
  ).toEqual([]);
  await f.t.mutation(internal.calendarFeeds.cleanupFeed, { id: f.id });
  expect((await f.t.run((ctx) => ctx.db.get(f.id)))?.calendars).toEqual([]);
});
it("keeps the prior snapshot truthful after provider failure and rejects failures from superseded leases", async () => {
  const f = await fixture();
  await f.claim();
  vi.setSystemTime(now + calendarLimits.leaseMs + 1);
  await f.claim(1, "new");
  expect(
    await f.t.mutation(internal.calendarFeeds.failed, {
      id: f.runId,
      version: 1,
      lease: "lease",
      retry: true,
      reconnect: false,
    }),
  ).toBe(false);
  expect(await f.page([f.event], 1, undefined, "new")).toBe(true);
  vi.setSystemTime(now + calendarLimits.leaseMs + 40_000);
  const next = await f.owner.mutation(api.calendarFeeds.sync, {
    id: f.id,
    version: 1,
  });
  await f.claim(1, "failed", next);
  await f.t.mutation(internal.calendarFeeds.failed, {
    id: next,
    version: 1,
    lease: "failed",
    retry: true,
    reconnect: false,
  });
  expect((await f.agenda()).events).toHaveLength(1);
  expect((await f.agenda()).availabilityKnown).toBe(false);
});
it("stops repeated abandoned leases within a bounded total budget", async () => {
  const f = await fixture();
  await f.t.run((ctx) =>
    ctx.db.patch(f.runId, { attempts: calendarLimits.pages * 3 }),
  );
  expect(await f.claim()).toBeNull();
  const run = await f.t.run((ctx) => ctx.db.get(f.runId));
  expect(run?.status).toBe("failed");
  expect((await f.owner.query(api.calendarFeeds.settings, {}))[0].syncing).toBe(
    false,
  );
});
it("stops at its page limit, labels a partial snapshot and does not schedule the next cursor", async () => {
  const f = await fixture();
  await f.t.run((ctx) =>
    ctx.db.patch(f.runId, { pages: calendarLimits.pages - 1 }),
  );
  await f.claim();
  await f.page([f.event], 1, "more");
  const run = await f.t.run((ctx) => ctx.db.get(f.runId));
  expect(run?.status).toBe("partial");
  expect((await f.agenda()).availabilityKnown).toBe(false);
  expect((await f.agenda()).events).toHaveLength(1);
  expect(await f.claim(2)).toBeNull();
});
it("removes expired paused snapshots and prevents private context use before physical cleanup", async () => {
  const f = await fixture();
  await f.claim();
  await f.page();
  await f.owner.mutation(api.calendarFeeds.change, {
    id: f.id,
    version: 1,
    operation: "pause",
  });
  vi.setSystemTime(now + calendarLimits.retentionMs + 1);
  expect((await f.agenda()).events).toEqual([]);
  await f.t.mutation(internal.calendarFeeds.poll, {});
  expect(
    (await f.t.run((ctx) => ctx.db.get(f.id)))?.publishedRunId,
  ).toBeUndefined();
  await f.t.mutation(internal.calendarFeeds.cleanupRun, { id: f.runId });
  expect(
    await f.t.run((ctx) => ctx.db.query("calendarFeedEvents").collect()),
  ).toEqual([]);
});
it("allows neither failed sync nor model planning to create approvals or writes", async () => {
  const f = await fixture();
  await f.claim();
  await f.page();
  const context = await f.t.query(internal.calendarFeeds.contextForAdult, {
    householdId: f.householdId,
    subject: "test|owner",
    from: now,
    through: now + 86400_000,
  });
  expect(context?.private).toBe(true);
  expect(context?.events[0].id).toBeTruthy();
  expect(JSON.stringify(context)).not.toMatch(
    /cipher|refresh_token|access_token/,
  );
  for (const table of [
    "actions",
    "approvals",
    "attempts",
    "planEvents",
    "receipts",
  ] as const)
    expect(await f.t.run((ctx) => ctx.db.query(table).collect())).toEqual([]);
});
it("chooses an explicitly writable destination with a versioned selection and preserves read grants", async () => {
  const f = await fixture();
  await f.t.run((ctx) =>
    ctx.db.patch(f.connectionId, {
      scopes: [
        googleCalendarReadScope,
        "https://www.googleapis.com/auth/calendar.events",
      ],
    }),
  );
  expect(
    await f.owner.mutation(internal.calendarFeeds.selectDestination, {
      connectionId: f.connectionId,
      connectionVersion: 1,
      selectionVersion: 0,
      calendarId: "primary",
      calendarName: "Family",
    }),
  ).toBe(1);
  const c = await f.t.run((ctx) => ctx.db.get(f.connectionId));
  expect(c?.version).toBe(1);
  expect(c?.calendarId).toBe("primary");
  await expect(
    f.owner.mutation(internal.calendarFeeds.selectDestination, {
      connectionId: f.connectionId,
      connectionVersion: 1,
      selectionVersion: 0,
      calendarId: "other",
      calendarName: "Other",
    }),
  ).rejects.toThrow("changed");
  await expect(
    f.other.mutation(internal.calendarFeeds.selectDestination, {
      connectionId: f.connectionId,
      connectionVersion: 1,
      selectionVersion: 1,
      calendarId: "other",
      calendarName: "Other",
    }),
  ).rejects.toThrow("changed");
  expect(await f.claim()).not.toBeNull();
});
it("starts a fresh read snapshot after verified changes without manufacturing an event or receipt", async () => {
  const f = await fixture();
  await f.claim();
  await f.page();
  await f.t.mutation(internal.calendarFeeds.afterWrite, {
    connectionId: f.connectionId,
    calendarId: "primary",
  });
  const feed = await f.t.run((ctx) => ctx.db.get(f.id));
  expect(feed?.version).toBe(2);
  expect(feed?.activeRunId).not.toBe(f.runId);
  expect((await f.agenda()).events).toEqual([]);
  expect(await f.t.run((ctx) => ctx.db.query("receipts").collect())).toEqual(
    [],
  );
});
it.each(['google', 'microsoft'] as const)('keeps %s external changes private and shared receipts historical after an edit or disappearance', async provider => {
  const f = await fixture(provider)
  const original = { kind: 'calendar' as const, childId: null, title: 'Shared original trip', date: '2026-10-14', endDate: '2026-10-14', startTime: '13:00', endTime: '14:00', allDay: false, timezone: 'UTC', location: 'Shared original gate', notes: '', targetId: null, evidence: {} }
  const savedId = await f.t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId: f.householdId, text: 'Reviewed calendar notice', revision: 1, hash: 'private-sync-test', expiresAt: now + 86400_000 })
    const jobId = await ctx.db.insert('jobs', { householdId: f.householdId, createdBy: 'test|owner', sourceId, preparing: false, cancelled: false, clarification: 'Calendar saved.' })
    const actionId = await ctx.db.insert('actions', { householdId: f.householdId, jobId, sourceRevision: 1, revision: 1, payload: original, status: 'succeeded' })
    await ctx.db.insert('receipts', { householdId: f.householdId, actionId, revision: 1, providerId: f.event.providerId, outcome: 'calendar_read_back_verified', verifiedAt: now })
    return ctx.db.insert('planEvents', { householdId: f.householdId, owner: 'test|owner', actionId, provider, connectionId: f.connectionId, connectionVersion: 1, eventId: f.event.providerId, calendarId: 'primary', etag: 'old', payload: original })
  })
  const saved = await f.t.run(ctx => ctx.db.get(savedId))
  await f.claim()
  await f.page([{ ...f.event, etag: 'external-revision', title: 'Private corrected trip', location: 'Private corrected gate' }])
  const owner = await f.agenda(), other = await f.other.query(api.calendarFeeds.agenda, { from: now, through: now + 86400_000 })
  expect(owner.events[0]).toMatchObject({ title: 'Private corrected trip', connectionId: f.connectionId, connectionVersion: 1, provider })
  expect(calendarPlanStatus(saved!, owner)).toContain('Calendar changed since this save')
  expect(calendarPlanStatus(saved!, other)).toBe('Last verified calendar details')
  expect(other.events).toEqual([])
  expect(other.coverage).toEqual([])
  expect(await f.owner.query(api.jobs.plan, {})).toEqual(await f.other.query(api.jobs.plan, {}))
  expect(JSON.stringify(await f.other.query(api.jobs.plan, {}))).not.toMatch(/Private corrected/)
  expect(await f.t.run(ctx => ctx.db.get(savedId))).toEqual(saved)
  vi.setSystemTime(now + 31_000)
  const next = await f.owner.mutation(api.calendarFeeds.sync, { id: f.id, version: 1 })
  await f.claim(1, 'missing-event', next)
  await f.page([], 1, undefined, 'missing-event', next)
  expect(calendarPlanStatus(saved!, await f.agenda())).toContain('Not in the latest checked window')
  expect(calendarPlanStatus(saved!, await f.other.query(api.calendarFeeds.agenda, { from: now, through: now + 86400_000 }))).toBe('Last verified calendar details')
  expect(await f.t.run(ctx => ctx.db.get(savedId))).toEqual(saved)
  expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toHaveLength(1)
})
