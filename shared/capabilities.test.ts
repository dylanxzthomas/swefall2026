import { describe, expect, it } from "vitest";
import {
  capabilityInventory,
  capabilityReply,
  type CapabilityId,
  type CapabilitySnapshot,
} from "./capabilities.js";

const googleScopes = [
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/gmail.send",
];
const device: CapabilitySnapshot = { mode: "device" };
const connected: CapabilitySnapshot = {
  mode: "connected",
  selected: { calendar: "google", email: "microsoft" },
  emailWatch: { enabled: false, permitted: false, modelConfigured: true },
  providers: {
    google: {
      configured: true,
      connection: { status: "active", scopes: googleScopes, hasCalendar: true },
    },
    microsoft: {
      configured: true,
      connection: {
        status: "active",
        scopes: ["Calendars.ReadWrite", "Mail.Send"],
        hasCalendar: true,
      },
    },
  },
};
const capability = (snapshot: CapabilitySnapshot, id: CapabilityId) =>
  capabilityInventory(snapshot).find((entry) => entry.id === id)!;

describe("connection-aware capability inventory", () => {
  it("supports household work locally without advertising cloud execution", () => {
    for (const id of [
      "household_tasks",
      "calendar_drafts",
      "email_drafts",
      "pickup_drafts",
      "library",
      "work_status",
      "scheduled_preparation",
      "family_memory",
    ] as const)
      expect(capability(device, id).availability).toBe("available");
    for (const id of [
      "google_calendar",
      "microsoft_calendar",
      "gmail_send",
      "outlook_send",
      "caregiver_requests",
    ] as const)
      expect(capability(device, id).availability).toBe("needs_connection");
    expect(capability(device, "apple_calendar").availability).toBe(
      "needs_iphone",
    );
    expect(capabilityReply("Can you schedule tasks?", device)).toContain(
      "when Daymark is next open",
    );
    expect(capabilityReply("Can you send emails?", device)).toContain(
      "nothing is sent from this device workspace",
    );
  });

  it("keeps calendar and mail selection independent, including mixed providers", () => {
    expect(capability(connected, "google_calendar").availability).toBe(
      "available",
    );
    expect(capability(connected, "outlook_send").availability).toBe(
      "available",
    );
    expect(capability(connected, "gmail_send").availability).toBe(
      "needs_selection",
    );
    expect(capability(connected, "microsoft_calendar").availability).toBe(
      "needs_selection",
    );
    expect(capabilityReply("Can you update my calendar?", connected)).toContain(
      "separate Daymark calendar in Google",
    );
    expect(capabilityReply("Can you send emails?", connected)).toContain(
      "through Outlook email",
    );
    expect(capabilityReply("Can you use Gmail?", connected)).toContain(
      "Choose it as your sending account",
    );
  });

  it("advertises private reviewed sending only with compose permission and current private processing consent", () => {
    const snapshot: CapabilitySnapshot = {
      mode: "connected",
      mailbox: { enabled: true, permitted: true, modelConfigured: true },
      providers: {
        google: {
          configured: true,
          connection: {
            status: "active",
            scopes: [
              "https://www.googleapis.com/auth/gmail.readonly",
              "https://www.googleapis.com/auth/gmail.compose",
            ],
            hasCalendar: false,
          },
        },
      },
    };
    expect(capability(snapshot, "gmail_send").availability).toBe("available");
    expect(capabilityReply("Can you send emails?", snapshot)).toContain(
      "separate approval",
    );
    expect(capabilityReply("Can you send emails?", snapshot)).toContain(
      "does not prove delivery",
    );
    for (const mailbox of [
      { ...snapshot.mailbox!, enabled: false },
      { ...snapshot.mailbox!, permitted: false },
    ])
      expect(
        capability({ ...snapshot, mailbox }, "gmail_send").availability,
      ).not.toBe("available");
    snapshot.providers!.google!.connection!.scopes = [
      "https://www.googleapis.com/auth/gmail.readonly",
    ];
    expect(capability(snapshot, "gmail_send").availability).not.toBe(
      "available",
    );
  });

  it("does not turn a calendar grant into mail access or mail access into calendar access", () => {
    const snapshot: CapabilitySnapshot = {
      ...connected,
      selected: { calendar: "google", email: "microsoft" },
      providers: {
        google: {
          configured: true,
          connection: {
            status: "active",
            scopes: [googleScopes[1]],
            hasCalendar: true,
          },
        },
        microsoft: {
          configured: true,
          connection: {
            status: "active",
            scopes: ["Calendars.ReadWrite"],
            hasCalendar: true,
          },
        },
      },
    };
    expect(capability(snapshot, "google_calendar").availability).toBe(
      "needs_permission",
    );
    expect(capability(snapshot, "outlook_send").availability).toBe(
      "needs_permission",
    );
    expect(capabilityReply("Can you send emails?", snapshot)).toContain(
      "sending permission",
    );
    const missingDestination: CapabilitySnapshot = {
      ...connected,
      providers: {
        google: {
          configured: true,
          connection: {
            status: "active",
            scopes: googleScopes,
            hasCalendar: false,
          },
        },
      },
    };
    expect(capability(missingDestination, "google_calendar").availability).toBe(
      "needs_connection",
    );
  });

  it("allows the selected Gmail sending account to reuse compose without assuming private reading consent", () => {
    const snapshot: CapabilitySnapshot = {
      mode: "connected",
      selected: { email: "google" },
      mailbox: { enabled: false, permitted: false, modelConfigured: true },
      providers: {
        google: {
          configured: true,
          connection: {
            status: "active",
            scopes: ["https://www.googleapis.com/auth/gmail.compose"],
            hasCalendar: false,
          },
        },
      },
    };
    expect(capability(snapshot, "gmail_send").availability).toBe("available");
    expect(capability(snapshot, "inbox_read").availability).toBe(
      "needs_permission",
    );
    expect(capabilityReply("Can you send emails?", snapshot)).toContain(
      "review and approve",
    );
    expect(
      capability({ ...snapshot, selected: {} }, "gmail_send").availability,
    ).toBe("needs_selection");
  });

  it("stops advertising execution when a connection is revoked, stale or unconfigured", () => {
    for (const status of [
      "revoked",
      "reconnect",
      "disconnected",
      "revocation_unconfirmed",
      "unknown",
    ]) {
      const snapshot: CapabilitySnapshot = {
        ...connected,
        providers: {
          google: {
            configured: true,
            connection: { status, scopes: googleScopes, hasCalendar: true },
          },
        },
      };
      expect(capability(snapshot, "google_calendar").availability).toBe(
        "needs_connection",
      );
      expect(
        capabilityReply("Can you use Google Calendar?", snapshot),
      ).toContain("Reconnect");
    }
    const unconfigured: CapabilitySnapshot = {
      ...connected,
      providers: {
        google: {
          configured: false,
          connection: {
            status: "active",
            scopes: googleScopes,
            hasCalendar: true,
          },
        },
      },
    };
    expect(capability(unconfigured, "google_calendar").availability).toBe(
      "needs_setup",
    );
    expect(
      capabilityReply("What can you do?", { mode: "connected" }),
    ).toContain("Connected accounts are needed");
    expect(capabilityReply("What can you do?", connected)).not.toContain(
      "Connected accounts are needed",
    );
  });

  it("uses the adapter scope casing rules without accepting broader but unsupported scope names", () => {
    const snapshot: CapabilitySnapshot = {
      mode: "connected",
      selected: { email: "microsoft" },
      providers: {
        microsoft: {
          configured: true,
          connection: {
            status: "active",
            scopes: ["mail.send"],
            hasCalendar: false,
          },
        },
      },
    };
    expect(capability(snapshot, "outlook_send").availability).toBe("available");
    snapshot.providers!.microsoft!.connection!.scopes = ["Mail.Read"];
    expect(capability(snapshot, "outlook_send").availability).toBe(
      "needs_permission",
    );
  });

  it("requires an authorized iPhone and calendar selection, including after revocation", () => {
    const iphone: CapabilitySnapshot = {
      mode: "device",
      apple: { available: true, permission: "granted", selected: true },
    };
    expect(capability(iphone, "apple_calendar").availability).toBe("available");
    expect(capabilityReply("Can you update my calendar?", iphone)).toContain(
      "not iCloud sync",
    );
    expect(
      capability(
        { ...iphone, apple: { ...iphone.apple!, permission: "denied" } },
        "apple_calendar",
      ).availability,
    ).toBe("needs_permission");
    expect(
      capability(
        { ...iphone, apple: { ...iphone.apple!, selected: false } },
        "apple_calendar",
      ).availability,
    ).toBe("needs_selection");
    const remote: CapabilitySnapshot = {
      ...iphone,
      mode: "connected",
      selected: { calendar: "apple" },
      apple: { ...iphone.apple!, selected: false, connectionStatus: "active" },
    };
    expect(capability(remote, "apple_calendar").availability).toBe(
      "needs_iphone",
    );
    expect(capabilityReply("Can you use Apple Calendar?", remote)).toContain(
      "another iPhone",
    );
    expect(
      capability(
        {
          ...remote,
          apple: {
            ...remote.apple!,
            selected: true,
            connectionStatus: "revoked",
          },
        },
        "apple_calendar",
      ).availability,
    ).toBe("needs_connection");
    expect(
      capability(
        { ...remote, apple: { ...remote.apple!, selected: true } },
        "apple_calendar",
      ).availability,
    ).toBe("available");
  });

  it("never infers monitoring or inbox reading from connected write scopes", () => {
    for (const id of ["purchases", "web_search"] as const)
      expect(capability(connected, id).availability).toBe("unsupported");
    expect(
      capabilityReply("Can you read my school email?", connected),
    ).toContain("cannot scan or read your inbox yet");
    expect(
      capabilityReply("Can you read my Outlook inbox?", connected),
    ).toContain("cannot scan or read your Outlook inbox yet");
    expect(capability(connected, "calendar_sync").availability).toBe(
      "needs_selection",
    );
    expect(capability(connected, "voice").availability).toBe("needs_setup");
    expect(capabilityReply("Can you read my calendar?", connected)).toContain(
      "current private processing consent",
    );
    expect(capability(connected, "inbox_read").availability).toBe(
      "needs_permission",
    );
    expect(capabilityReply("Are you watching my email?", connected)).toContain(
      "cannot scan or read",
    );
    expect(
      capabilityReply("Can you work in the background?", connected),
    ).toContain("cannot scan or read");
    expect(capabilityReply("Can you schedule tasks?", connected)).toContain(
      "external changes and messages still wait for your approval",
    );
  });

  it("distinguishes caregiver delivery setup and acceptance from drafting", () => {
    expect(capability(connected, "caregiver_requests").availability).toBe(
      "needs_setup",
    );
    const ready = { ...connected, caregiverDeliveryReady: true };
    expect(capability(ready, "caregiver_requests").availability).toBe(
      "available",
    );
    expect(capabilityReply("Can you arrange pickups?", ready)).toContain(
      "only arranged after the caregiver accepts",
    );
    expect(capabilityReply("Can you arrange pickups?", ready)).toContain(
      "after your approval",
    );
  });

  it("keeps the context inventory free of private source records and connection material", () => {
    const snapshot = {
      ...connected,
      accessToken: "private-token",
      householdId: "private-household",
      providers: {
        google: {
          ...connected.providers!.google!,
          connection: {
            ...connected.providers!.google!.connection!,
            email: "private@example.test",
            cipher: "private-cipher",
            calendarId: "private-calendar",
          },
        },
      },
    };
    const json = JSON.stringify(capabilityInventory(snapshot));
    for (const secret of [
      "private-token",
      "private-household",
      "private@example.test",
      "private-cipher",
      "private-calendar",
      googleScopes[0],
    ])
      expect(json).not.toContain(secret);
  });
});

describe("explicit capability questions", () => {
  it("answers household capability questions with truthful limits", () => {
    expect(capabilityReply("What can you help me with?", device)).toContain(
      "household organized",
    );
    expect(
      capabilityReply("Can you help me manage the household?", device),
    ).toContain("Tasks");
    expect(capabilityReply("Can you save photos?", device)).toContain(
      "Library",
    );
    expect(capabilityReply("Can you buy school supplies?", device)).toContain(
      "cannot browse shops, buy items or place orders yet",
    );
    expect(capabilityReply("Can you search the web?", device)).toContain(
      "cannot search the web",
    );
    expect(capabilityReply("Do you support voice mode?", device)).toContain(
      "provider setup",
    );
    expect(
      capabilityReply("What accounts are connected?", connected),
    ).toContain("Outlook email");
    expect(capabilityReply("Can you book activities?", connected)).toContain(
      "cannot book activities",
    );
    expect(capabilityReply("Do you have your own browser?", device)).toContain(
      "does not reserve a slot",
    );
    expect(
      capabilityReply("What accounts are connected?", connected),
    ).toContain("does not connect an account");
  });

  it("does not swallow operational requests, notices, mixed instructions or completed-work questions", () => {
    for (const text of [
      "Can you send my teacher an absence email?",
      "Can you arrange Maya’s pickup tomorrow?",
      "Help me organize the field trip",
      "Please read my school email",
      "Can you order school supplies from this link?",
      "Add an event to my calendar",
      "What can you do about tomorrow’s trip?",
      "Can you send emails? Send one to my teacher.",
      "Can you read my inbox?\nSchool notice: early dismissal Friday.",
      "The email asks: Can you read my calendar?",
      "Show me what you can do and send everything now",
      "Can you search the web for backpacks?",
      "Can you book a swim lesson tomorrow?",
      "Do you have your own browser? Book me a table.",
      "What are you handling for me?",
      "Did you send that email?",
      "",
    ])
      expect(capabilityReply(text, connected), text).toBeNull();
  });
});

it("describes only enabled, permitted sender watches and separates enabled from checked", () => {
  const watching: CapabilitySnapshot = {
    ...connected,
    providers: {
      ...connected.providers,
      google: {
        configured: true,
        connection: {
          status: "active",
          scopes: [
            ...googleScopes,
            "https://www.googleapis.com/auth/gmail.readonly",
          ],
          hasCalendar: true,
        },
      },
    },
    emailWatch: { enabled: true, permitted: true, modelConfigured: true },
  };
  expect(capabilityReply("Are you watching my email?", watching)).toContain(
    "has not completed its first check",
  );
  expect(capabilityReply("Can you read my Outlook inbox?", watching)).toContain(
    "cannot scan or read your Outlook inbox",
  );
  expect(capabilityReply("Are you watching my calendar?", watching)).toContain(
    "current private processing consent",
  );
  watching.emailWatch!.lastCheckedAt = Date.parse("2026-10-05T12:00:00Z");
  expect(capabilityReply("Are you watching my email?", watching)).toContain(
    "2026-10-05T12:00:00.000Z",
  );
  watching.emailWatch!.enabled = false;
  expect(capabilityReply("Are you watching my email?", watching)).toContain(
    "not watching",
  );
});

it("explains reviewed memory and routines without claiming automatic learning", () => {
  expect(capability(device, "family_memory").requiresApproval).toBe(true);
  expect(
    capabilityReply("Can you remember household details?", device),
  ).toContain("review and edit");
  expect(
    capabilityReply("Can you remember household details?", device),
  ).toContain("do not learn new permissions");
  expect(capabilityReply("Can you create routines?", device)).toContain(
    "when Daymark is next open",
  );
  expect(capabilityReply("Can you create routines?", connected)).toContain(
    "only the latest missed",
  );
});

it("describes private inbox assistance from current consent and separates Gmail draft permission", () => {
  const snapshot = {
    mode: "connected" as const,
    mailbox: { enabled: true, permitted: true, modelConfigured: false },
    providers: {
      google: {
        configured: true,
        connection: {
          status: "active",
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          hasCalendar: false,
        },
      },
    },
  };
  const inventory = capabilityInventory(snapshot);
  expect(inventory.find((c) => c.id === "inbox_read")).toMatchObject({
    availability: "available",
  });
  expect(inventory.find((c) => c.id === "inbox_read")!.description).toContain(
    "private to you",
  );
  expect(inventory.find((c) => c.id === "inbox_read")!.description).toContain(
    "summaries need model setup",
  );
  expect(capabilityReply("What can you do?", snapshot)).toContain(
    "private Gmail help",
  );
  expect(capabilityReply("What can you do?", snapshot)).not.toContain(
    "selected senders",
  );
  expect(inventory.find((c) => c.id === "gmail_drafts")).toMatchObject({
    availability: "needs_permission",
    requiresApproval: true,
  });
  expect(
    capabilityInventory({
      ...snapshot,
      mailbox: { ...snapshot.mailbox, permitted: false },
    }).find((c) => c.id === "inbox_read"),
  ).toMatchObject({ availability: "needs_selection" });
  expect(
    capabilityInventory({
      ...snapshot,
      providers: {
        google: {
          ...snapshot.providers.google,
          connection: {
            ...snapshot.providers.google.connection,
            scopes: [
              ...snapshot.providers.google.connection.scopes,
              "https://www.googleapis.com/auth/gmail.compose",
            ],
          },
        },
      },
    }).find((c) => c.id === "gmail_drafts"),
  ).toMatchObject({ availability: "available", requiresApproval: true });
});

it("separates private calendar consent and freshness from approved event editing grants", () => {
  const read: CapabilitySnapshot = {
    mode: "connected",
    providers: {
      google: {
        configured: true,
        connection: {
          status: "active",
          scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
          hasCalendar: false,
        },
      },
    },
  };
  expect(capability(read, "calendar_sync").availability).toBe(
    "needs_selection",
  );
  expect(capability(read, "google_calendar").availability).toBe(
    "needs_permission",
  );
  const enabled: CapabilitySnapshot = {
    ...read,
    calendarFeeds: {
      enabled: true,
      permitted: true,
      fresh: true,
      partial: false,
      issue: false,
    },
  };
  expect(capability(enabled, "calendar_sync").availability).toBe("available");
  expect(capability(enabled, "calendar_sync").description).toContain(
    "previous week and next 90 days",
  );
  expect(capability(enabled, "calendar_sync").description).toContain(
    "private to you",
  );
  expect(capability(enabled, "calendar_sync").description).toContain(
    "separate optional setting",
  );
  expect(
    capability(
      {
        ...enabled,
        calendarFeeds: {
          ...enabled.calendarFeeds!,
          assistanceEnabled: true,
          modelConfigured: true,
        },
      },
      "calendar_sync",
    ).description,
  ).toContain("meaningful changes in complete, fresh calendar checks");
  expect(capabilityReply("What can you do?", enabled)).not.toContain(
    "cannot monitor your full calendar",
  );
  expect(
    capability(
      {
        ...enabled,
        calendarFeeds: { ...enabled.calendarFeeds!, fresh: false },
      },
      "calendar_sync",
    ).description,
  ).toContain("availability needs a fresh check");
  expect(
    capability(
      {
        ...enabled,
        calendarFeeds: { ...enabled.calendarFeeds!, partial: true },
      },
      "calendar_sync",
    ).description,
  ).toContain("cannot establish that a time is free");
  for (const field of ["enabled", "permitted"] as const)
    expect(
      capability(
        {
          ...enabled,
          calendarFeeds: { ...enabled.calendarFeeds!, [field]: false },
        },
        "calendar_sync",
      ).availability,
    ).toBe("needs_selection");
  const editing: CapabilitySnapshot = {
    ...enabled,
    selected: { calendar: "google" },
    providers: {
      google: {
        configured: true,
        connection: {
          status: "active",
          scopes: ["https://www.googleapis.com/auth/calendar.events"],
          hasCalendar: true,
        },
      },
    },
  };
  expect(capability(editing, "google_calendar").availability).toBe("available");
  expect(capability(editing, "google_calendar").description).toContain(
    "selected writable calendar",
  );
  expect(capability(editing, "calendar_sync").availability).toBe(
    "needs_permission",
  );
});
it("advertises configured optional voice, reviewed learning and separate attachment consent without inventing execution", () => {
  expect(
    capability({ ...connected, voice: { configured: true } }, "voice")
      .availability,
  ).toBe("available");
  expect(
    capability({ ...connected, voice: { configured: true } }, "voice")
      .description,
  ).toContain("Spoken acknowledgments do not approve");
  expect(capability(connected, "family_memory").description).toContain(
    "Proposed routines start paused",
  );
  const mail: CapabilitySnapshot = {
    ...connected,
    mailbox: { enabled: true, permitted: true, modelConfigured: true },
    providers: {
      google: {
        configured: true,
        connection: {
          status: "active",
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          hasCalendar: false,
        },
      },
    },
  };
  expect(capability(mail, "inbox_read").description).toContain(
    "separate private processing consent",
  );
});
