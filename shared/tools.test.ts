import { expect, it } from "vitest";
import { event } from "../tests/fixtures/calendar.js";
import {
  assertToolBudget,
  registeredTool,
  resolveApprovedTool,
  toolRegistry,
  validateToolGrant,
} from "./tools.js";

const email = {
  kind: "email",
  childId: "maya",
  to: "teacher@example.test",
  subject: "School trip",
  body: "Please confirm the details.",
  requirement: "",
  evidence: {},
};
const pickup = {
  kind: "pickup",
  childId: "maya",
  caregiverId: "synthetic-caregiver",
  date: "2027-05-05",
  time: "15:00",
  timezone: "UTC",
  location: "North gate",
  deadline: "2027-05-05T12:00:00Z",
  message: "Can you pick up Maya?",
  evidence: {},
};

it("resolves each implemented provider operation from approved data, including legacy Google defaults", () => {
  expect(resolveApprovedTool(event, {}).tool.name).toBe(
    "calendar.google.commit",
  );
  for (const provider of ["google", "microsoft", "apple"])
    expect(resolveApprovedTool(event, { provider }).tool.name).toBe(
      `calendar.${provider}.commit`,
    );
  for (const provider of ["google", "microsoft"])
    expect(resolveApprovedTool(email, { provider }).tool.name).toBe(
      `email.${provider}.send`,
    );
  expect(resolveApprovedTool(pickup, {}).tool.name).toBe(
    "caregiver.email.request",
  );
  expect(
    resolveApprovedTool(pickup, { deliveryChannel: "app" }).tool.name,
  ).toBe("caregiver.app.request");
  expect(resolveApprovedTool(event, { provider: "apple" }).tool).toMatchObject({
    location: "iphone",
    adapter: "approved_native_calendar",
    grant: "calendar.local.full",
    approval: "exact_action_revision",
  });
});

it("blocks unknown tools, versions, providers, delivery channels, and switched approved tools", () => {
  for (const selection of [
    { provider: "arbitrary" },
    { provider: "google", toolName: "browser.click" },
    { toolVersion: 99 },
    { deliveryChannel: "app" },
  ])
    expect(() => resolveApprovedTool(event, selection)).toThrow();
  expect(() => resolveApprovedTool(email, { provider: "apple" })).toThrow();
  expect(() =>
    resolveApprovedTool(pickup, { deliveryChannel: "sms" }),
  ).toThrow();
  expect(() => resolveApprovedTool(pickup, { provider: "google" })).toThrow();
  expect(() =>
    registeredTool("https://untrusted.example/execute", 1),
  ).toThrow();
});

it("strictly validates arguments including nested payloads and does not accept executable URLs", () => {
  expect(() =>
    resolveApprovedTool(
      { ...event, tool: "send_email", url: "https://untrusted.example" },
      {},
    ),
  ).toThrow();
  expect(() =>
    resolveApprovedTool(
      { ...pickup, calendarUpdate: { ...event, execute: true } },
      {},
    ),
  ).toThrow();
  expect(() =>
    resolveApprovedTool(
      {
        ...email,
        attachments: [
          {
            id: "file",
            name: "notice.pdf",
            hash: "hash",
            url: "https://untrusted.example/file",
          },
        ],
      },
      {},
    ),
  ).toThrow();
  expect(() =>
    resolveApprovedTool(
      { kind: "booking", destination: "https://untrusted.example" },
      {},
    ),
  ).toThrow();
});

it("caps serialized input, adapter fan-out, and attempts without granting a retry after uncertainty", () => {
  const { tool } = resolveApprovedTool(event, {});
  expect(() =>
    assertToolBudget(tool, {
      argumentBytes: 1000,
      previousAttempts: 7,
      adapterCalls: 1,
    }),
  ).not.toThrow();
  for (const budget of [
    { argumentBytes: 64001, previousAttempts: 0, adapterCalls: 1 },
    { argumentBytes: 1000, previousAttempts: 8, adapterCalls: 1 },
    { argumentBytes: 1000, previousAttempts: 0, adapterCalls: 2 },
    { argumentBytes: 1000, previousAttempts: -1, adapterCalls: 1 },
  ])
    expect(() => assertToolBudget(tool, budget)).toThrow("execution limit");
  const evidence = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`quote${i}`, "a".repeat(2000)]),
  );
  expect(() => resolveApprovedTool({ ...event, evidence }, {})).toThrow(
    "execution limit",
  );
});

it("checks actual grants, calendar destination and the authorized native installation", () => {
  const { tool } = resolveApprovedTool(event, { provider: "apple" });
  const connection = {
    provider: "apple",
    status: "active",
    scopes: ["calendar.local.full"],
    calendarId: "calendar",
    nativeDeviceId: "phone",
  };
  expect(() =>
    validateToolGrant(tool, connection, "calendar", "phone"),
  ).not.toThrow();
  for (const changed of [
    { ...connection, scopes: [] },
    { ...connection, status: "revoked" },
    { ...connection, provider: "google" },
    { ...connection, nativeDeviceId: "other-phone" },
  ])
    expect(() =>
      validateToolGrant(tool, changed, "calendar", "phone"),
    ).toThrow();
  expect(() =>
    validateToolGrant(tool, connection, "other-calendar", "phone"),
  ).toThrow();
  expect(() => validateToolGrant(tool, connection, "calendar")).toThrow();
});

it("keeps the synthetic booking descriptions visibly unavailable and immutable", () => {
  for (const name of ["booking.synthetic.prepare", "booking.synthetic.commit"])
    expect(registeredTool(name, 1)).toMatchObject({
      adapter: "unavailable",
      location: "synthetic_browser",
    });
  expect(registeredTool("booking.synthetic.prepare", 1).classification).toBe(
    "prepare",
  );
  expect(registeredTool("booking.synthetic.commit", 1).classification).toBe(
    "commit",
  );
  expect(
    new Set(toolRegistry.map((tool) => `${tool.name}:${tool.version}`)).size,
  ).toBe(toolRegistry.length);
  expect(Object.isFrozen(toolRegistry)).toBe(true);
  expect(Object.isFrozen(toolRegistry[0].limits)).toBe(true);
});

it("accepts compose for Gmail sending without confusing reading, providers or lookalike grants", () => {
  const { tool } = resolveApprovedTool(email, { provider: "google" });
  const connection = {
    provider: "google",
    status: "active",
    scopes: ["https://www.googleapis.com/auth/gmail.compose"],
  };
  expect(() => validateToolGrant(tool, connection, email.to)).not.toThrow();
  for (const scopes of [
    [],
    ["https://www.googleapis.com/auth/gmail.readonly"],
    ["https://www.googleapis.com/auth/gmail.compose.extra"],
    ["gmail.compose"],
    ["https://www.googleapis.com/auth/gmail.modify"],
  ])
    expect(() =>
      validateToolGrant(tool, { ...connection, scopes }, email.to),
    ).toThrow("permission");
  for (const changed of [
    { ...connection, provider: "microsoft" },
    { ...connection, status: "revoked" },
  ])
    expect(() => validateToolGrant(tool, changed, email.to)).toThrow(
      "permission",
    );
});
it("accepts explicit Google event editing permission while keeping readonly grants and destinations separate", () => {
  const { tool } = resolveApprovedTool(event, { provider: "google" }),
    connection = {
      provider: "google",
      status: "active",
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      calendarId: "selected-calendar",
    };
  expect(() =>
    validateToolGrant(tool, connection, "selected-calendar"),
  ).not.toThrow();
  for (const scopes of [
    ["https://www.googleapis.com/auth/calendar.readonly"],
    ["https://www.googleapis.com/auth/calendar.events.extra"],
    [],
  ])
    expect(() =>
      validateToolGrant(tool, { ...connection, scopes }, "selected-calendar"),
    ).toThrow("permission");
  expect(() => validateToolGrant(tool, connection, "other-calendar")).toThrow(
    "destination",
  );
});
