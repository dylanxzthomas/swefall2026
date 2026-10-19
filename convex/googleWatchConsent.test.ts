// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { OAuth2Client } from "google-auth-library";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { seal, unseal } from "./googleCrypto";
import { gmailReadScope } from "../shared/emailWatches";
const writes = vi.hoisted(() => ({ insert: vi.fn(), get: vi.fn() }));
vi.mock("@googleapis/calendar", () => ({
  calendar: () => ({ calendars: writes, calendarList: { get: writes.get } }),
}));
const modules = import.meta.glob("./**/*.ts");
const calendar = "https://www.googleapis.com/auth/calendar.app.created",
  send = "https://www.googleapis.com/auth/gmail.send";
beforeEach(() => {
  vi.stubEnv(
    "PROVIDER_TOKEN_KEYS",
    JSON.stringify({ test: Buffer.alloc(32, 9).toString("base64") }),
  );
  vi.stubEnv("PROVIDER_TOKEN_KEY_ID", "test");
  vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("CONVEX_SITE_URL", "https://synthetic.convex.site");
  vi.stubEnv("DAYMARK_WEB_URL", "https://synthetic.example.test");
  vi.stubEnv("DAYMARK_ENVIRONMENT", "development");
  vi.stubEnv("DAYMARK_TEST_GOOGLE_EMAILS", "synthetic@example.test");
  vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
    getPayload: () => ({
      email: "synthetic@example.test",
      email_verified: true,
    }),
  } as any);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  writes.insert.mockReset();
  writes.get.mockReset();
});
it("requests incremental read consent without creating calendars or switching selected sending accounts", async () => {
  const t = convexTest(schema, modules),
    parent = t.withIdentity({
      subject: "parent",
      tokenIdentifier: "test|parent",
    });
  const householdId = await parent.mutation(api.households.save, {
    timezone: "UTC",
    children: [],
  });
  const binding = `${householdId}:test|parent`;
  const id = await t.run((ctx) =>
    ctx.db.insert("connections", {
      householdId,
      subject: "test|parent",
      provider: "google",
      version: 1,
      status: "active",
      email: "synthetic@example.test",
      calendarId: "existing-calendar",
      scopes: [calendar, send],
      cipher: seal(
        { access_token: "synthetic-old", refresh_token: "synthetic-refresh" },
        binding,
      ),
    }),
  );
  const outlook = await t.run((ctx) =>
    ctx.db.insert("connections", {
      householdId,
      subject: "test|parent",
      provider: "microsoft",
      version: 1,
      status: "active",
      scopes: ["Mail.Send"],
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("connectionPreferences", {
      householdId,
      subject: "test|parent",
      version: 1,
      calendarConnectionId: id,
      emailConnectionId: outlook,
    }),
  );
  const url = new URL(
    await parent.action(api.google.connect, {
      purpose: "watch",
      native: false,
    }),
  );
  expect(url.searchParams.get("scope")?.split(" ")).toContain(gmailReadScope);
  expect(url.searchParams.get("include_granted_scopes")).toBe("true");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({
    tokens: {
      id_token: "synthetic",
      access_token: "synthetic-new",
      scope: [calendar, send, gmailReadScope].join(" "),
    },
  } as any);
  expect(
    await t.action(internal.google.callback, {
      state: url.searchParams.get("state")!,
      code: "synthetic-code",
    }),
  ).toContain("connection=connected");
  const record = await t.query(internal.connections.privateRecord, { id });
  expect(record).toMatchObject({
    calendarId: "existing-calendar",
    scopes: [calendar, send, gmailReadScope],
    version: 2,
  });
  expect(unseal(record!.cipher!, binding)).toMatchObject({
    refresh_token: "synthetic-refresh",
    access_token: "synthetic-new",
  });
  const selected = await parent.query(api.connections.overview, {});
  expect(selected.emailId).toBe(outlook);
  expect(selected.calendarId).toBe(id);
  expect(writes.insert).not.toHaveBeenCalled();
});
it("does not accept a sending-only token as watch consent", async () => {
  const t = convexTest(schema, modules),
    parent = t.withIdentity({
      subject: "parent",
      tokenIdentifier: "test|parent",
    });
  await parent.mutation(api.households.save, { timezone: "UTC", children: [] });
  const url = new URL(
    await parent.action(api.google.connect, {
      purpose: "watch",
      native: false,
    }),
  );
  vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({
    tokens: {
      id_token: "synthetic",
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      scope: send,
    },
  } as any);
  await expect(
    t.action(internal.google.callback, {
      state: url.searchParams.get("state")!,
      code: "synthetic-code",
    }),
  ).rejects.toThrow("permission was not granted");
  expect(writes.insert).not.toHaveBeenCalled();
});

it("returns local reading consent to the normal 127.0.0.1 preview without provider writes", async () => {
  vi.stubEnv("DAYMARK_WEB_URL", "http://127.0.0.1:5173");
  vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
  const t = convexTest(schema, modules),
    parent = t.withIdentity({ subject: "local-consent" });
  await parent.mutation(api.households.save, { timezone: "UTC", children: [] });
  const url = new URL(
    await parent.action(api.google.connect, {
      purpose: "watch",
      native: false,
    }),
  );
  expect(url.searchParams.get("redirect_uri")).toBe(
    "http://127.0.0.1:3211/google/callback",
  );
  expect(
    await t.action(internal.google.callback, {
      state: url.searchParams.get("state")!,
    }),
  ).toBe("http://127.0.0.1:5173?connection=cancelled");
  expect(writes.insert).not.toHaveBeenCalled();
});

it("requests Gmail draft permission separately and preserves reading grants without calendar writes", async () => {
  const compose = "https://www.googleapis.com/auth/gmail.compose";
  const t = convexTest(schema, modules),
    parent = t.withIdentity({
      subject: "draft-parent",
      tokenIdentifier: "test|draft-parent",
    });
  const householdId = await parent.mutation(api.households.save, {
    timezone: "UTC",
    children: [],
  });
  const binding = `${householdId}:test|draft-parent`;
  const id = await t.run((ctx) =>
    ctx.db.insert("connections", {
      householdId,
      subject: "test|draft-parent",
      provider: "google",
      version: 1,
      status: "active",
      email: "synthetic@example.test",
      scopes: [gmailReadScope],
      cipher: seal(
        { access_token: "synthetic-old", refresh_token: "synthetic-refresh" },
        binding,
      ),
    }),
  );
  const url = new URL(
    await parent.action(api.google.connect, {
      purpose: "compose",
      native: false,
    }),
  );
  expect(url.searchParams.get("scope")?.split(" ")).toEqual([
    "openid",
    "email",
    compose,
  ]);
  expect(url.searchParams.get("include_granted_scopes")).toBe("true");
  vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({
    tokens: {
      id_token: "synthetic",
      access_token: "synthetic-new",
      scope: [gmailReadScope, compose].join(" "),
    },
  } as any);
  await t.action(internal.google.callback, {
    state: url.searchParams.get("state")!,
    code: "synthetic-code",
  });
  const record = await t.query(internal.connections.privateRecord, { id });
  expect(record).toMatchObject({
    scopes: [gmailReadScope, compose],
    version: 2,
  });
  expect(unseal(record!.cipher!, binding)).toMatchObject({
    refresh_token: "synthetic-refresh",
    access_token: "synthetic-new",
  });
  expect(await parent.query(api.jobs.list, {})).toEqual([]);
  expect(writes.insert).not.toHaveBeenCalled();
});
it("rejects draft consent that returns only reading permission", async () => {
  const t = convexTest(schema, modules),
    parent = t.withIdentity({ subject: "draft-parent" });
  await parent.mutation(api.households.save, { timezone: "UTC", children: [] });
  const url = new URL(
    await parent.action(api.google.connect, {
      purpose: "compose",
      native: false,
    }),
  );
  vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({
    tokens: {
      id_token: "synthetic",
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      scope: gmailReadScope,
    },
  } as any);
  await expect(
    t.action(internal.google.callback, {
      state: url.searchParams.get("state")!,
      code: "synthetic-code",
    }),
  ).rejects.toThrow("permission was not granted");
});

it("requests read and event editing separately without creating a calendar", async () => {
  const t = convexTest(schema, modules),
    parent = t.withIdentity({
      subject: "parent",
      tokenIdentifier: "test|parent",
    });
  await parent.mutation(api.households.save, { timezone: "UTC", children: [] });
  for (const [purpose, scope] of [
    ["calendar_read", "https://www.googleapis.com/auth/calendar.readonly"],
    ["calendar_events", "https://www.googleapis.com/auth/calendar.events"],
  ] as const) {
    const url = new URL(
      await parent.action(api.google.connect, { purpose, native: false }),
    );
    expect(url.searchParams.get("scope")?.split(" ")).toContain(scope);
    expect(url.searchParams.get("scope")).not.toContain("calendar.app.created");
  }
  expect(writes.insert).not.toHaveBeenCalled();
});
it("checks provider writability before versioned selection of an existing Google calendar", async () => {
  const t = convexTest(schema, modules),
    parent = t.withIdentity({
      subject: "parent",
      tokenIdentifier: "test|parent",
    }),
    householdId = await parent.mutation(api.households.save, {
      timezone: "UTC",
      children: [],
    });
  const connectionId = await t.run((ctx) =>
    ctx.db.insert("connections", {
      householdId,
      subject: "test|parent",
      provider: "google",
      version: 1,
      status: "active",
      scopes: [
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events",
      ],
      cipher: seal(
        {
          access_token: "synthetic-only",
          refresh_token: "synthetic-refresh",
          expiry_date: Date.now() + 3600_000,
        },
        `${householdId}:test|parent`,
      ),
    }),
  );
  writes.get.mockResolvedValueOnce({
    data: { id: "chosen", summary: "Family", accessRole: "reader" },
  });
  await expect(
    parent.action(api.google.selectCalendar, {
      connectionId,
      connectionVersion: 1,
      selectionVersion: 0,
      calendarId: "chosen",
    }),
  ).rejects.toThrow("not writable");
  writes.get.mockResolvedValueOnce({
    data: { id: "chosen", summary: "Family", accessRole: "owner" },
  });
  expect(
    await parent.action(api.google.selectCalendar, {
      connectionId,
      connectionVersion: 1,
      selectionVersion: 0,
      calendarId: "chosen",
    }),
  ).toBe(1);
  expect(
    await t.query(internal.connections.privateRecord, { id: connectionId }),
  ).toMatchObject({ calendarId: "chosen", calendarName: "Family", version: 1 });
  await expect(
    parent.action(api.google.selectCalendar, {
      connectionId,
      connectionVersion: 1,
      selectionVersion: 0,
      calendarId: "other",
    }),
  ).rejects.toThrow("changed");
  expect(writes.insert).not.toHaveBeenCalled();
});
