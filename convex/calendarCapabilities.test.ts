import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { capabilitiesFor } from "./assistantContext";
import { capabilityInventory } from "../shared/capabilities";
import { sourceHash } from "../shared/daymark";
import {
  googleCalendarReadScope,
  calendarLimits,
} from "../shared/calendarAwareness";
const modules = import.meta.glob("./**/*.ts"),
  now = Date.parse("2026-10-14T18:00Z");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-secret");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
it("maps only current same-adult private feed consent and snapshot freshness into secret-free model descriptions", async () => {
  const t = convexTest(schema, modules),
    owner = t.withIdentity({
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
        status: "active",
        version: 1,
        scopes: [googleCalendarReadScope],
        email: "private@example.test",
        cipher: "synthetic-not-a-credential",
      }),
    ),
    feedId = await t.run((ctx) =>
      ctx.db.insert("calendarFeeds", {
        householdId,
        createdBy: "test|parent",
        connectionId,
        connectionVersion: 1,
        accountKey: sourceHash(
          JSON.stringify([connectionId, "private@example.test"]),
        ),
        provider: "google",
        version: 1,
        state: "active",
        calendars: [
          {
            id: "private-calendar-id",
            name: "Private calendar name",
            timezone: "UTC",
          },
        ],
        createdAt: now,
        consentedAt: now,
      }),
    ),
    runId = await t.run((ctx) =>
      ctx.db.insert("calendarFeedRuns", {
        householdId,
        createdBy: "test|parent",
        feedId,
        feedVersion: 1,
        connectionVersion: 1,
        status: "complete",
        version: 1,
        from: now - 86400_000,
        through: now + 86400_000,
        pages: 1,
        eventCount: 1,
        omitted: 0,
        calendarIndex: 1,
        createdAt: now,
        expiresAt: now + calendarLimits.retentionMs,
      }),
    );
  await t.run((ctx) =>
    ctx.db.patch(feedId, { publishedRunId: runId, lastCheckedAt: now }),
  );
  const get = () =>
      t.run(async (ctx) =>
        capabilityInventory(
          await capabilitiesFor(ctx, householdId, "test|parent"),
        ),
      ),
    read = () =>
      get().then((items) => items.find((i) => i.id === "calendar_sync")!);
  expect(await read()).toMatchObject({ availability: "available" });
  expect((await read()).description).toContain(
    "recent selected-window snapshot",
  );
  const encoded = JSON.stringify(await get());
  for (const text of [
    "private@example.test",
    "private-calendar-id",
    "Private calendar name",
    "synthetic-not-a-credential",
    connectionId,
    feedId,
  ])
    expect(encoded).not.toContain(text);
  vi.setSystemTime(now + calendarLimits.freshnessMs + 1);
  expect((await read()).description).toContain("fresh check");
  await t.run((ctx) => ctx.db.patch(feedId, { state: "paused" }));
  expect((await read()).availability).toBe("needs_selection");
  await t.run((ctx) => ctx.db.patch(feedId, { state: "active" }));
  await t.run((ctx) => ctx.db.patch(connectionId, { version: 2 }));
  expect((await read()).availability).toBe("needs_selection");
  const other = await t.run(async (ctx) =>
    capabilityInventory(await capabilitiesFor(ctx, householdId, "test|other")),
  );
  expect(other.find((i) => i.id === "calendar_sync")?.availability).not.toBe(
    "available",
  );
});
