// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import workflow from "@convex-dev/workflow/test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sourceHash } from "../shared/daymark";
import { googleCalendarReadScope } from "../shared/calendarAwareness";
const mock = vi.hoisted(() => ({ get: vi.fn(), microsoft: vi.fn() }));
vi.mock("@googleapis/calendar", () => ({
  calendar: () => ({ events: { get: mock.get } }),
}));
vi.mock("./google", () => ({
  withGoogle: async (
    _ctx: unknown,
    _ref: unknown,
    work: (auth: unknown) => unknown,
  ) => work({}),
}));
vi.mock('./microsoft', () => ({ withMicrosoft: async (_ctx: unknown, _id: unknown, _version: unknown, work: (token: string) => unknown) => work('synthetic-unused-token') }))
vi.mock('./microsoftAdapter', async importOriginal => ({ ...await importOriginal<typeof import('./microsoftAdapter')>(), microsoftRequest: mock.microsoft }))
const modules = import.meta.glob("./**/*.ts"),
  now = Date.parse("2026-10-14T12:00Z");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mock.get.mockReset();
  mock.microsoft.mockReset();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
async function fixture() {
  const t = convexTest(schema, modules);
  workflow.register(t);
  const owner = t.withIdentity({
      subject: "owner",
      tokenIdentifier: "test|owner",
    }),
    other = t.withIdentity({ subject: "other", tokenIdentifier: "test|other" }),
    householdId = await owner.mutation(api.households.save, {
      timezone: "UTC",
      children: [{ id: "maya", name: "Maya" }],
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
      provider: "google",
      status: "active",
      version: 1,
      scopes: [
        googleCalendarReadScope,
        "https://www.googleapis.com/auth/calendar.events",
      ],
      calendarId: "primary",
      email: "calendar@example.test",
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("connectionPreferences", {
      householdId,
      subject: "test|owner",
      version: 1,
      calendarConnectionId: connectionId,
    }),
  );
  const accountKey = sourceHash(
      JSON.stringify([connectionId, "calendar@example.test"]),
    ),
    feedId = await t.run((ctx) =>
      ctx.db.insert("calendarFeeds", {
        householdId,
        createdBy: "test|owner",
        connectionId,
        connectionVersion: 1,
        provider: "google",
        accountKey,
        version: 1,
        state: "active",
        calendars: [{ id: "primary", name: "Family", timezone: "UTC" }],
        consentedAt: now,
        createdAt: now,
      }),
    ),
    runId = await t.run((ctx) =>
      ctx.db.insert("calendarFeedRuns", {
        householdId,
        createdBy: "test|owner",
        feedId,
        feedVersion: 1,
        connectionVersion: 1,
        version: 2,
        status: "complete",
        from: now - 86400_000,
        through: now + 86400_000,
        calendarIndex: 1,
        pages: 1,
        eventCount: 1,
        omitted: 0,
        createdAt: now,
        expiresAt: now + 86400_000,
      }),
    );
  await t.run((ctx) =>
    ctx.db.patch(feedId, { publishedRunId: runId, lastCheckedAt: now }),
  );
  const eventId = await t.run((ctx) =>
    ctx.db.insert("calendarFeedEvents", {
      householdId,
      createdBy: "test|owner",
      feedId,
      runId,
      key: "one",
      event: {
        providerId: "provider-event",
        calendarId: "primary",
        title: "Dinner",
        location: "Home",
        start: Date.parse("2026-10-14T18:00Z"),
        end: Date.parse("2026-10-14T19:00Z"),
        allDay: false,
        timezone: "UTC",
        busy: true,
        recurring: false,
        etag: "etag1",
      },
      expiresAt: now + 86400_000,
    }),
  );
  const raw = {
    id: "provider-event",
    etag: "etag1",
    summary: "Dinner",
    location: "Home",
    description: "Bring salad",
    start: { dateTime: "2026-10-14T18:00:00Z" },
    end: { dateTime: "2026-10-14T19:00:00Z" },
    status: "confirmed",
  };
  mock.get.mockResolvedValue({ data: raw });
  return { t, owner, other, householdId, connectionId, feedId, eventId, raw };
}
it("inspects current provider details privately without creating jobs, imported records or approvals", async () => {
  const f = await fixture(),
    preview = await f.owner.action(api.calendarReading.inspectEvent, {
      eventId: f.eventId,
    });
  expect(preview.original).toMatchObject({
    title: "Dinner",
    notes: "Bring salad",
    startTime: "18:00",
  });
  for (const table of [
    "jobs",
    "actions",
    "planEvents",
    "approvals",
    "receipts",
  ] as const)
    expect(await f.t.run((ctx) => ctx.db.query(table).collect())).toEqual([]);
  await expect(
    f.other.action(api.calendarReading.inspectEvent, { eventId: f.eventId }),
  ).rejects.toThrow("Select");
  expect(JSON.stringify(preview)).not.toMatch(
    /cipher|access_token|refresh_token/,
  );
});
it("shares only exact reviewed original and edited fields into a targeted unapproved workflow, deduplicating concurrent preparation", async () => {
  const f = await fixture(),
    preview = await f.owner.action(api.calendarReading.inspectEvent, {
      eventId: f.eventId,
    }),
    { original, originalHash, provider, ...ref } = preview,
    proposed = {
      ...original,
      title: "Dinner with family",
      startTime: "18:30",
      endTime: "19:30",
      childId: "maya",
    };
  const args = { ...ref, origin: ref.origin ? { ...ref.origin, id: ref.origin.id as Id<"assistantRuns"> } : undefined, originalHash, proposed, consent: true as const };
  const jobs = await Promise.all(
    Array.from({ length: 30 }, () =>
      f.owner.action(api.calendarReading.prepareEventChange, args),
    ),
  );
  expect(new Set(jobs).size).toBe(1);
  const records = await f.t.run((ctx) => ctx.db.query("planEvents").collect());
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    external: true,
    eventId: "provider-event",
    etag: "etag1",
    owner: "test|owner",
  });
  const actions = await f.t.run((ctx) => ctx.db.query("actions").collect());
  expect(actions).toHaveLength(1);
  expect(actions[0]).toMatchObject({
    status: "review",
    payload: { title: "Dinner with family", targetId: records[0]._id },
    before: { eventId: "provider-event", etag: "etag1", external: true },
  });
  const source = await f.t.run((ctx) => ctx.db.query("sources").first());
  expect(source?.text).toContain("Dinner with family");
  expect(source?.text).toContain("Bring salad");
  for (const table of ["approvals", "attempts", "receipts"] as const)
    expect(await f.t.run((ctx) => ctx.db.query(table).collect())).toEqual([]);
});
it("blocks outdated edits after provider changes, pause, new grant or destination change", async () => {
  for (const change of ["provider", "pause", "grant", "destination"] as const) {
    const f = await fixture(),
      preview = await f.owner.action(api.calendarReading.inspectEvent, {
        eventId: f.eventId,
      }),
      { original, provider, ...ref } = preview;
    if (change === "provider")
      mock.get.mockResolvedValue({
        data: { ...f.raw, etag: "changed", summary: "New dinner" },
      });
    if (change === "pause")
      await f.t.run((ctx) =>
        ctx.db.patch(f.feedId, { state: "paused", version: 2 }),
      );
    if (change === "grant")
      await f.t.run((ctx) => ctx.db.patch(f.connectionId, { version: 2 }));
    if (change === "destination")
      await f.t.run((ctx) =>
        ctx.db.patch(f.connectionId, { calendarId: "different" }),
      );
    await expect(
      f.owner.action(api.calendarReading.prepareEventChange, {
        ...ref, origin: ref.origin ? { ...ref.origin, id: ref.origin.id as Id<"assistantRuns"> } : undefined,
        proposed: original,
        consent: true,
      }),
    ).rejects.toThrow();
    expect(await f.t.run((ctx) => ctx.db.query("jobs").collect())).toEqual([]);
  }
});
it("refuses unsupported meetings, recurring instances and oversized or malformed event details before sharing", async () => {
  const f = await fixture();
  for (const change of [
    { attendees: [{ email: "guest@example.test" }] },
    { recurringEventId: "series" },
    { conferenceData: { conferenceId: "online" } },
    { description: "x".repeat(2001) },
    { end: { dateTime: "not-a-date" } },
  ]) {
    mock.get.mockResolvedValue({ data: { ...f.raw, ...change } });
    await expect(
      f.owner.action(api.calendarReading.inspectEvent, { eventId: f.eventId }),
    ).rejects.toThrow();
  }
  expect(await f.t.run((ctx) => ctx.db.query("planEvents").collect())).toEqual(
    [],
  );
});
it("binds the eventual approval to the imported provider identity and selected destination, invalidating a later destination change", async () => {
  const f = await fixture(),
    preview = await f.owner.action(api.calendarReading.inspectEvent, {
      eventId: f.eventId,
    }),
    { original, provider, ...ref } = preview;
  await f.owner.action(api.calendarReading.prepareEventChange, {
    ...ref, origin: ref.origin ? { ...ref.origin, id: ref.origin.id as Id<"assistantRuns"> } : undefined,
    proposed: {
      ...original,
      childId: "maya",
      title: "Dinner at 7",
      startTime: "19:00",
      endTime: "20:00",
    },
    consent: true,
  });
  const action = (await f.t.run((ctx) => ctx.db.query("actions").first()))!;
  await f.owner.mutation(api.jobs.approve, {
    actions: [{ id: action._id, revision: 1, selectionVersion: 1 }],
  });
  const approved = (await f.t.run((ctx) => ctx.db.get(action._id)))!,
    approval = (await f.t.run((ctx) => ctx.db.get(approved.approvalId!)))!;
  expect(approval).toMatchObject({
    connectionId: f.connectionId,
    connectionVersion: 1,
    destination: "primary",
    selectionVersion: 1,
  });
  expect(approved.before).toMatchObject({
    eventId: "provider-event",
    etag: "etag1",
    external: true,
  });
  await f.owner.mutation(internal.calendarFeeds.selectDestination, {
    connectionId: f.connectionId,
    connectionVersion: 1,
    selectionVersion: 1,
    calendarId: "other",
    calendarName: "Other",
  });
  expect(
    await f.t.mutation(internal.execution.claim, {
      actionId: action._id,
      approvalId: approval._id,
    }),
  ).toBeNull();
  expect((await f.t.run((ctx) => ctx.db.get(action._id)))?.status).toBe(
    "review",
  );
  expect(await f.t.run((ctx) => ctx.db.query("attempts").collect())).toEqual(
    [],
  );
});
it("records a verified external update without losing its preservation marker or manufacturing provider proof", async () => {
  const f = await fixture(),
    preview = await f.owner.action(api.calendarReading.inspectEvent, {
      eventId: f.eventId,
    }),
    { original, provider, ...ref } = preview;
  await f.owner.action(api.calendarReading.prepareEventChange, {
    ...ref, origin: ref.origin ? { ...ref.origin, id: ref.origin.id as Id<"assistantRuns"> } : undefined,
    proposed: {
      ...original,
      childId: "maya",
      title: "Dinner at 7",
      startTime: "19:00",
      endTime: "20:00",
    },
    consent: true,
  });
  const action = (await f.t.run((ctx) => ctx.db.query("actions").first()))!;
  await f.owner.mutation(api.jobs.approve, {
    actions: [{ id: action._id, revision: 1, selectionVersion: 1 }],
  });
  const approved = (await f.t.run((ctx) => ctx.db.get(action._id)))!,
    claim = (await f.t.mutation(internal.execution.claim, {
      actionId: action._id,
      approvalId: approved.approvalId!,
    }))!;
  await expect(
    f.t.mutation(internal.execution.finish, {
      attemptId: claim.attemptId,
      status: "succeeded",
      providerId: "provider-event",
      etag: "etag2",
    }),
  ).rejects.toThrow("receipt");
  expect(
    await f.t.mutation(internal.execution.dispatch, {
      attemptId: claim.attemptId,
    }),
  ).toBe(true);
  await f.t.mutation(internal.execution.finish, {
    attemptId: claim.attemptId,
    status: "succeeded",
    providerId: "provider-event",
    etag: "etag2",
  });
  const target = await f.t.run((ctx) => ctx.db.query("planEvents").first());
  expect(target).toMatchObject({
    eventId: "provider-event",
    etag: "etag2",
    external: true,
    payload: { title: "Dinner at 7" },
  });
  expect(
    await f.t.run((ctx) => ctx.db.query("receipts").collect()),
  ).toHaveLength(1);
});

async function assistantCalendar(f: Awaited<ReturnType<typeof fixture>>, ambiguous = false) {
  const ids = await f.t.run(async ctx => {
    const text = 'Move my existing dinner event one hour later.'
    const sourceId = await ctx.db.insert('sources', { householdId: f.householdId, text, hash: sourceHash(text), revision: 1, expiresAt: now + 86400_000 })
    const jobId = await ctx.db.insert('jobs', { householdId: f.householdId, createdBy: 'test|owner', sourceId, interactive: true, preparing: true, cancelled: false, clarification: '' })
    let secondId
    if (ambiguous) {
      const { _id, _creationTime, ...row } = (await ctx.db.get(f.eventId))!
      secondId = await ctx.db.insert('calendarFeedEvents', { ...row, key: 'second-event', event: { ...row.event, providerId: 'another-provider-event', title: 'Other dinner' } })
    }
    return { sourceId, jobId, secondId }
  })
  const runId = (await f.t.mutation(internal.assistantCoordinator.start, { jobId: ids.jobId, sourceRevision: 1 }))!
  const advance = async (version: number, tool: string, rest = {}) => {
    expect(await f.t.mutation(internal.assistantCoordinator.claim, { id: runId, version, lease: `calendar-${version}` })).not.toBeNull()
    expect(await f.t.mutation(internal.assistantCoordinator.advance, { id: runId, version, lease: `calendar-${version}`, result: JSON.stringify({ tool, query: '', id: '', from: '', through: '', answer: '', drafts: [], ...rest }) })).toBe(true)
  }
  await advance(1, 'family_context')
  await advance(2, 'calendar_events', { from: '2026-10-14T00:00Z', through: '2026-10-15T00:00Z' })
  await advance(3, 'finish', { answer: 'Review the existing dinner event and choose the exact time.', drafts: [{ kind: 'calendar', title: 'Move dinner', text: 'Move the current dinner event to 19:00–20:00 UTC.', evidence: [{ sourceId: f.eventId, quote: '"title":"Dinner"' }, ...(ids.secondId ? [{ sourceId: ids.secondId, quote: '"title":"Other dinner"' }] : [])] }] })
  const run = (await f.owner.query(api.assistantCoordinator.list, {})).find(r => r.id === runId)!
  return { ...ids, runId, origin: { id: runId, version: run.version, index: 0 }, run }
}
it.each(['save', 'delete'] as const)('hands an assistant %s of an external-only event into exact targeted review, never a create or approval', async operation => {
  const f = await fixture(), a = await assistantCalendar(f)
  expect(a.run.drafts[0]).toMatchObject({ calendarReviewRequired: true, calendarSource: { eventId: f.eventId, provider: 'google' } })
  await expect(f.owner.mutation(api.assistantCoordinator.review, { id: a.runId, version: a.origin.version, index: 0, text: a.run.drafts[0].text, operation: 'share', consent: true })).rejects.toThrow('existing connected calendar event')
  expect(await f.t.run(ctx => ctx.db.query('planEvents').collect())).toEqual([])
  const preview = await f.owner.action(api.calendarReading.inspectEvent, { eventId: f.eventId, origin: a.origin })
  const { original, provider, originalHash, ...ref } = preview
  const proposed = { ...original, operation, startTime: '19:00', endTime: '20:00' }
  const jobId = await f.owner.action(api.calendarReading.prepareEventChange, { ...ref, origin: a.origin, originalHash, proposed, consent: true })
  const action = (await f.t.run(ctx => ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', jobId as any)).unique()))!
  expect(action).toMatchObject({ status: 'review', payload: { operation, targetId: expect.any(String) }, before: { eventId: 'provider-event', etag: 'etag1' } })
  expect((await f.t.run(ctx => ctx.db.get(action.payload.targetId)))!).toMatchObject({ eventId: 'provider-event', connectionId: f.connectionId, connectionVersion: 1 })
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toEqual([])
  // Sharing its own original-event record must not invalidate sibling private work.
  expect((await f.owner.query(api.assistantCoordinator.list, {})).find(r => r.id === a.runId)!.stale).toBe(false)
})
it.each(['source', 'provider', 'selection', 'grant', 'feed'] as const)('blocks assistant calendar handoff after %s changes without creating household work', async change => {
  const f = await fixture(), a = await assistantCalendar(f)
  const preview = await f.owner.action(api.calendarReading.inspectEvent, { eventId: f.eventId, origin: a.origin })
  const { original, provider, ...ref } = preview
  if (change === 'source') await f.t.run(ctx => ctx.db.patch(a.sourceId, { revision: 2, text: 'A different request.' }))
  if (change === 'provider') mock.get.mockResolvedValue({ data: { ...f.raw, etag: 'changed-provider-etag', start: { dateTime: '2026-10-14T17:00Z' } } })
  if (change === 'selection') await f.owner.mutation(internal.calendarFeeds.selectDestination, { connectionId: f.connectionId, connectionVersion: 1, selectionVersion: 1, calendarId: 'different', calendarName: 'Different' })
  if (change === 'grant') await f.t.run(ctx => ctx.db.patch(f.connectionId, { version: 2 }))
  if (change === 'feed') await f.t.run(ctx => ctx.db.patch(f.feedId, { version: 2 }))
  await expect(f.owner.action(api.calendarReading.prepareEventChange, { ...ref, origin: a.origin, proposed: { ...original, startTime: '19:00', endTime: '20:00' }, consent: true })).rejects.toThrow()
  expect(await f.t.run(ctx => ctx.db.query('planEvents').collect())).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('jobs').collect())).toHaveLength(1)
})
it('blocks ambiguous calendar citations from generic create preparation and rejects another adult’s origin', async () => {
  const f = await fixture(), a = await assistantCalendar(f, true)
  expect(a.run.drafts[0].calendarReviewRequired).toBe(true)
  expect(a.run.drafts[0].calendarSource).toBeUndefined()
  await expect(f.owner.mutation(api.assistantCoordinator.review, { id: a.runId, version: a.origin.version, index: 0, text: a.run.drafts[0].text, operation: 'share', consent: true })).rejects.toThrow('existing connected calendar event')
  await expect(f.other.action(api.calendarReading.inspectEvent, { eventId: f.eventId, origin: a.origin })).rejects.toThrow()
  expect(await f.t.run(ctx => ctx.db.query('planEvents').collect())).toEqual([])
})
it('rejects a mismatched provider event identity before importing its details', async () => {
  const f = await fixture()
  mock.get.mockResolvedValue({ data: { ...f.raw, id: 'different-event' } })
  await expect(f.owner.action(api.calendarReading.inspectEvent, { eventId: f.eventId })).rejects.toThrow('different event')
  expect(await f.t.run(ctx => ctx.db.query('planEvents').collect())).toEqual([])
})
it.each(['save', 'delete'] as const)('preserves the Outlook event identity through assistant %s review without provider writes', async operation => {
  const f = await fixture()
  await f.t.run(async ctx => {
    await ctx.db.patch(f.connectionId, { provider: 'microsoft', scopes: ['Calendars.ReadWrite'] })
    await ctx.db.patch(f.feedId, { provider: 'microsoft' })
  })
  mock.microsoft.mockResolvedValue({ data: { id: 'provider-event', '@odata.etag': 'etag1', subject: 'Dinner', location: { displayName: 'Home' }, body: { contentType: 'text', content: 'Bring salad' }, start: { dateTime: '2026-10-14T18:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-10-14T19:00:00', timeZone: 'UTC' }, isAllDay: false, type: 'singleInstance' } })
  const a = await assistantCalendar(f)
  expect(a.run.drafts[0].calendarSource?.provider).toBe('microsoft')
  const preview = await f.owner.action(api.calendarReading.inspectEvent, { eventId: f.eventId, origin: a.origin })
  const { original, provider, ...ref } = preview
  await f.owner.action(api.calendarReading.prepareEventChange, { ...ref, origin: a.origin, proposed: { ...original, operation, startTime: '19:00', endTime: '20:00' }, consent: true })
  const action = (await f.t.run(ctx => ctx.db.query('actions').first()))!
  expect(action).toMatchObject({ status: 'review', before: { eventId: 'provider-event', provider: 'microsoft', etag: 'etag1' }, payload: { operation, targetId: expect.any(String) } })
  expect(mock.microsoft).toHaveBeenCalledTimes(2)
  expect(mock.microsoft.mock.calls.every(call => call[2] === undefined)).toBe(true)
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
})
