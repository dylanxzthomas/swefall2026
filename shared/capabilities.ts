import {
  canSendGmail,
  canWriteGoogleCalendar,
  googleCalendarEventsScope,
} from "./googlePermissions.js";
/** Display/context information only. Execution must recheck server authorization and approval. */
export type CloudProvider = "google" | "microsoft";
export type CapabilityAvailability =
  | "available"
  | "needs_connection"
  | "needs_permission"
  | "needs_iphone"
  | "needs_selection"
  | "needs_setup"
  | "unsupported";
export type CapabilityId =
  | "household_tasks"
  | "calendar_drafts"
  | "email_drafts"
  | "pickup_drafts"
  | "library"
  | "work_status"
  | "scheduled_preparation"
  | "family_memory"
  | "google_calendar"
  | "microsoft_calendar"
  | "apple_calendar"
  | "gmail_send"
  | "gmail_drafts"
  | "outlook_send"
  | "caregiver_requests"
  | "inbox_read"
  | "calendar_sync"
  | "proactive_monitoring"
  | "purchases"
  | "bookings"
  | "web_search"
  | "voice";

/** Map authorized records into this small view; never pass credentials or private account IDs. */
export type CapabilityConnection = {
  status: string;
  scopes: readonly string[];
  hasCalendar: boolean;
};
export type CapabilitySnapshot = {
  mode: "device" | "connected";
  providers?: Partial<
    Record<
      CloudProvider,
      { configured: boolean; connection?: CapabilityConnection | null }
    >
  >;
  selected?: { calendar?: CloudProvider | "apple"; email?: CloudProvider };
  apple?: {
    available: boolean;
    permission: "prompt" | "granted" | "denied";
    /** A writable calendar is selected on this installation, not another iPhone. */
    selected: boolean;
    connectionStatus?: string;
  };
  mailbox?: {
    enabled: boolean;
    permitted: boolean;
    modelConfigured: boolean;
    lastCheckedAt?: number;
    issue?: boolean;
  };
  emailWatch?: {
    enabled: boolean;
    permitted: boolean;
    modelConfigured: boolean;
    lastCheckedAt?: number;
    issue?: boolean;
  };
  calendarFeeds?: {
    enabled: boolean;
    permitted: boolean;
    fresh: boolean;
    partial: boolean;
    issue: boolean;
    assistanceEnabled?: boolean;
    modelConfigured?: boolean;
  };
  voice?: { configured: boolean };
  caregiverDeliveryReady?: boolean;
};
export type Capability = {
  id: CapabilityId;
  label: string;
  availability: CapabilityAvailability;
  location: "workspace" | "server" | "iphone" | "unavailable";
  requiresApproval: boolean;
  description: string;
};

const scopes = {
  google: {
    calendar: "https://www.googleapis.com/auth/calendar.app.created",
    email: "https://www.googleapis.com/auth/gmail.send",
  },
  microsoft: { calendar: "Calendars.ReadWrite", email: "Mail.Send" },
} as const;
const names = {
  google: { calendar: "Google Calendar", email: "Gmail" },
  microsoft: { calendar: "Outlook Calendar", email: "Outlook email" },
} as const;

function cloudCapability(
  snapshot: CapabilitySnapshot,
  provider: CloudProvider,
  purpose: "calendar" | "email",
): Capability {
  const label = names[provider][purpose];
  const id: CapabilityId =
    purpose === "calendar"
      ? provider === "google"
        ? "google_calendar"
        : "microsoft_calendar"
      : provider === "google"
        ? "gmail_send"
        : "outlook_send";
  const entry = snapshot.providers?.[provider],
    connection = entry?.connection;
  const base = {
    id,
    label,
    location: "server" as const,
    requiresApproval: true,
  };
  if (snapshot.mode === "device")
    return {
      ...base,
      availability: "needs_connection",
      description: `${label} is not connected to this device workspace. Keep the draft here, or open a connected workspace to connect an account.`,
    };
  if (!entry?.configured)
    return {
      ...base,
      availability: "needs_setup",
      description: `${label} connection setup is still needed. I can prepare a draft in the meantime.`,
    };
  if (!connection || connection.status !== "active")
    return {
      ...base,
      availability: "needs_connection",
      description: `${connection ? "Reconnect" : "Connect"} ${label} in Household settings before I can ${purpose === "calendar" ? "apply approved calendar changes" : "send an approved email"}.`,
    };
  if (
    provider === "google" &&
    purpose === "email" &&
    connection.scopes.includes(
      "https://www.googleapis.com/auth/gmail.compose",
    ) &&
    snapshot.mailbox?.enabled &&
    snapshot.mailbox.permitted
  )
    return {
      ...base,
      availability: "available",
      description:
        "From your private email review, I can save or update a reviewed Sola-created Gmail draft, then send that exact verified reply after a separate approval. I check the sent copy; this does not prove delivery. Standalone household email drafts use the separately selected sending account.",
    };
  const hasScope =
    provider === "google"
      ? purpose === "email"
        ? canSendGmail(connection.scopes)
        : canWriteGoogleCalendar(connection.scopes)
      : connection.scopes.some(
          (scope) =>
            scope.toLowerCase() === scopes[provider][purpose].toLowerCase(),
        );
  if (!hasScope)
    return {
      ...base,
      availability: "needs_permission",
      description: `${label} needs ${purpose === "calendar" ? "calendar" : "sending"} permission. Connect it for ${purpose === "calendar" ? "calendar changes" : "email"} in Household settings; every ${purpose === "calendar" ? "change" : "send"} still needs your approval.`,
    };
  if (purpose === "calendar" && !connection.hasCalendar)
    return {
      ...base,
      availability: "needs_connection",
      description: `${label} has no usable calendar destination. Reconnect it in Household settings before approving a change.`,
    };
  if (snapshot.selected?.[purpose] !== provider)
    return {
      ...base,
      availability: "needs_selection",
      description: `${label} is connected. Choose it as your ${purpose === "calendar" ? "calendar destination" : "sending account"} in Household settings to use it for approved ${purpose === "calendar" ? "changes" : "emails"}.`,
    };
  return {
    ...base,
    availability: "available",
    description:
      purpose === "calendar"
        ? `I can apply calendar changes you review and approve to ${provider === "google" && !connection.scopes.includes(googleCalendarEventsScope) ? "your separate Daymark calendar in Google" : "your selected writable calendar"}, then read back the saved result. Selected individual events can be reviewed for updates or removal; meetings, recurring events and special settings need provider editing. Reading other calendars requires separate private calendar consent.`
        : `I can send emails you review and approve through ${label}. A receipt records provider acceptance; it does not prove delivery or a reply. Sending access does not let me read your inbox.`,
  };
}

function appleCapability(snapshot: CapabilitySnapshot): Capability {
  const native = snapshot.apple;
  const base = {
    id: "apple_calendar" as const,
    label: "Apple Calendar",
    location: "iphone" as const,
    requiresApproval: true,
  };
  if (!native?.available)
    return {
      ...base,
      availability: "needs_iphone",
      description:
        "Apple Calendar needs the iPhone app. Open Daymark on the connected iPhone to review permission and apply approved changes; the browser cannot write to Apple Calendar.",
    };
  if (native.permission !== "granted")
    return {
      ...base,
      availability: "needs_permission",
      description:
        "Allow full Calendar access on this iPhone, then choose a writable calendar in Household settings. Changes still need your approval.",
    };
  if (snapshot.mode === "connected" && native.connectionStatus !== "active")
    return {
      ...base,
      availability: "needs_connection",
      description:
        "Reconnect Apple Calendar in Household settings on this iPhone before approving a change.",
    };
  if (
    snapshot.mode === "connected" &&
    snapshot.selected?.calendar === "apple" &&
    !native.selected
  )
    return {
      ...base,
      availability: "needs_iphone",
      description:
        "Your selected Apple calendar belongs to another iPhone. Open Daymark on that connected iPhone to apply approved changes, or choose a calendar on this phone and review again.",
    };
  if (
    !native.selected ||
    (snapshot.mode === "connected" && snapshot.selected?.calendar !== "apple")
  )
    return {
      ...base,
      availability: "needs_selection",
      description:
        "Choose a writable Apple calendar in Household settings on this iPhone before approving a change.",
    };
  return {
    ...base,
    availability: "available",
    description:
      "I can apply calendar changes you review and approve on this iPhone and read them back. That confirms the phone’s calendar, not iCloud sync. The app needs to be open to handle the change.",
  };
}

function fixed(
  id: CapabilityId,
  label: string,
  description: string,
  availability: "available" | "unsupported" = "available",
  location: Capability["location"] = "workspace",
): Capability {
  return {
    id,
    label,
    description,
    availability,
    location,
    requiresApproval: false,
  };
}

function privateMailboxCapability(
  snapshot: CapabilitySnapshot,
  id: "inbox_read" | "proactive_monitoring",
): Capability {
  const base = {
    id,
    label: id === "inbox_read" ? "Private Gmail assistance" : "Gmail checks",
    location: "server" as const,
    requiresApproval: false,
  };
  const box = snapshot.mailbox!,
    google = snapshot.providers?.google,
    c = google?.connection;
  if (!google?.configured)
    return {
      ...base,
      availability: "needs_setup",
      description:
        "Gmail connection setup is needed. I have not read your inbox. You can share a specific email manually in the meantime.",
    };
  if (!c || c.status !== "active")
    return {
      ...base,
      availability: "needs_connection",
      description:
        "Connect Gmail in Household settings to let me read your private inbox. Connecting does not send or share mail.",
    };
  if (!c.scopes.includes("https://www.googleapis.com/auth/gmail.readonly"))
    return {
      ...base,
      availability: "needs_permission",
      description:
        "Gmail needs separate reading permission. Sending permission does not allow inbox reading.",
    };
  if (!box.enabled || !box.permitted)
    return {
      ...base,
      availability: "needs_selection",
      description:
        "Enable or resume private email help in the Gmail connection row before asking me to check your inbox.",
    };
  return {
    ...base,
    availability: "available",
    description:
      "I can check your Gmail inbox across senders and search email when you ask. Messages and summaries stay private to you until you explicitly share an item. Checks process bounded pages and show incomplete coverage. Supported Gmail attachments can be read only after separate private processing consent; linked pages are not read. " +
      (box.lastCheckedAt
        ? "A prior check completed; request a fresh check for current evidence."
        : "The first check has not completed yet.") +
      (box.modelConfigured
        ? " I can use saved thread and confirmed family context to prepare source-backed private summaries, parent tasks, calendar proposals and reply text from selected messages. You can edit, keep, dismiss or snooze that preparation; sharing and provider writes need their own review."
        : " AI summaries need model setup; extracted messages can still be reviewed.") +
      (box.issue ? " The current connection or check needs attention." : "") +
      " Background checks require the configured backend to be running. Nothing is sent or added to a calendar without approval.",
  };
}
function gmailDraftCapability(snapshot: CapabilitySnapshot): Capability {
  const base = {
    id: "gmail_drafts" as const,
    label: "Save a Gmail draft",
    location: "server" as const,
    requiresApproval: true,
  };
  const c = snapshot.providers?.google?.connection;
  if (snapshot.mode === "device" || !c || c.status !== "active")
    return {
      ...base,
      availability: "needs_connection",
      description:
        "Saving a draft in Gmail requires a connected Gmail account. An in-app draft is not a Gmail draft or a sent email.",
    };
  if (!c.scopes.includes("https://www.googleapis.com/auth/gmail.compose"))
    return {
      ...base,
      availability: "needs_permission",
      description:
        "Grant Gmail draft permission when you choose to save a reviewed reply. Reading alone cannot create a Gmail draft. Google draft permission includes sending, but Sola requires separate approvals to save a draft and to send it.",
    };
  if (
    snapshot.mailbox &&
    (!snapshot.mailbox.enabled || !snapshot.mailbox.permitted)
  )
    return {
      ...base,
      availability: "needs_selection",
      description:
        "Enable or resume private Gmail help and review a current source before saving a reply. Existing connection grants do not approve a draft.",
    };
  return {
    ...base,
    availability: "available",
    description:
      "I can save a reviewed private reply as an unsent Gmail draft, or update the same Sola-created draft after fresh approval. Saving never sends it. Sending the exact verified reply needs a separate approval. If the source or account changes, review a fresh reply first.",
  };
}

function calendarReadingCapability(snapshot: CapabilitySnapshot): Capability {
  const base = {
    id: "calendar_sync" as const,
    label: "Private calendar reading",
    location: "server" as const,
    requiresApproval: false,
  };
  if (snapshot.mode === "device")
    return {
      ...base,
      availability: "needs_connection",
      description:
        "Connect Google or Microsoft in a connected workspace and choose calendars before I can read existing events. Apple Calendar stays on its authorized iPhone; device Plan entries are not full calendar sync.",
    };
  const entries = [snapshot.providers?.google, snapshot.providers?.microsoft];
  if (!entries.some((e) => e?.configured))
    return {
      ...base,
      availability: "needs_setup",
      description:
        "Private calendar reading needs connector setup. I can prepare calendar drafts using the details you share.",
    };
  const google = snapshot.providers?.google?.connection,
    microsoft = snapshot.providers?.microsoft?.connection;
  const liveGoogle =
      !!snapshot.providers?.google?.configured && google?.status === "active",
    liveMicrosoft =
      !!snapshot.providers?.microsoft?.configured &&
      microsoft?.status === "active";
  if (!liveGoogle && !liveMicrosoft)
    return {
      ...base,
      availability: "needs_connection",
      description:
        "Connect a Google or Microsoft calendar account, grant reading access and choose the calendars Sola may privately read.",
    };
  const permitted =
    (liveGoogle &&
      google.scopes.includes(
        "https://www.googleapis.com/auth/calendar.readonly",
      )) ||
    (liveMicrosoft &&
      microsoft.scopes.some((s) =>
        ["calendars.read", "calendars.readwrite"].includes(s.toLowerCase()),
      ));
  if (!permitted)
    return {
      ...base,
      availability: "needs_permission",
      description:
        "Calendar reading is separate from saving approved events. Grant reading access, then choose calendars and confirm private processing in Household settings.",
    };
  const feeds = snapshot.calendarFeeds;
  if (!feeds?.enabled || !feeds.permitted)
    return {
      ...base,
      availability: "needs_selection",
      description:
        "Calendar reading permission is connected, but Sola needs your selected calendars and current private processing consent. Enable or resume calendar reading in Household settings; an existing write grant does not enable scanning.",
    };
  return {
    ...base,
    availability: "available",
    description:
      "I can privately read your selected Google or Microsoft calendars, see existing events and flag overlapping times. Checks cover the previous week and next 90 days in bounded pages, normally refreshed about every 15 minutes. This is selected-window reading, not an exhaustive calendar or an instant push feed. " +
      (!feeds.fresh
        ? "A current check has not completed; availability needs a fresh check. "
        : feeds.partial || feeds.issue
          ? "Some coverage is incomplete or needs attention; I cannot establish that a time is free. "
          : "A recent selected-window snapshot is available; outside edits can happen after a check. ") +
      (feeds.assistanceEnabled && feeds.modelConfigured
        ? "You enabled private follow-ups for meaningful changes in complete, fresh calendar checks. Unchanged checks stay quiet; follow-ups are model prepared, bounded and private for your review. "
        : "Proactive calendar follow-ups require a separate optional setting and assistant model setup; reading consent alone does not enable them. ") +
      "Calendar events remain private to you. Sharing and every external calendar change need separate review and approval.",
  };
}
function voiceCapability(snapshot: CapabilitySnapshot): Capability {
  const base = {
    id: "voice" as const,
    label: "Voice conversation",
    location: "server" as const,
    requiresApproval: false,
  };
  if (snapshot.mode === "device")
    return {
      ...base,
      availability: "needs_connection",
      description:
        "Keyboard dictation can put editable text in your composer. Optional live voice needs a signed-in connected workspace and provider setup.",
    };
  if (!snapshot.voice?.configured)
    return {
      ...base,
      availability: "needs_setup",
      description:
        "Live voice needs provider setup before you can start it. Keyboard dictation still puts editable text in the composer. No microphone is listening by default.",
    };
  return {
    ...base,
    availability: "available",
    description:
      "You can explicitly start a live voice conversation, mute or end it, and submit a transcript for the same private assistant workflow. Microphone permission is requested when starting. Spoken acknowledgments do not approve external actions; review the exact action on screen. Phone interruptions and audio behavior still need device acceptance testing.",
  };
}

function emailWatchCapability(
  snapshot: CapabilitySnapshot,
  id: "inbox_read" | "proactive_monitoring",
): Capability {
  if (snapshot.mailbox && snapshot.mode === "connected")
    return privateMailboxCapability(snapshot, id);
  const base = {
    id,
    label: id === "inbox_read" ? "Read selected email" : "Email watch",
    location: "server" as const,
    requiresApproval: false,
  };
  if (snapshot.mode === "device")
    return {
      ...base,
      availability: "needs_connection",
      description:
        id === "inbox_read"
          ? "I cannot scan or read your inbox yet in this device workspace. Connect Gmail in a connected workspace after granting reading permission and private email consent."
          : "I am not watching your email or calendar in this device workspace. A Gmail watch needs a connected workspace and your explicit permission.",
    };
  const watch = snapshot.emailWatch,
    google = snapshot.providers?.google,
    c = google?.connection;
  if (!google?.configured || !watch?.modelConfigured)
    return {
      ...base,
      availability: "needs_setup",
      description:
        "I am not watching your inbox. Gmail reading and automatic preparation need setup before a sender-specific watch can run. Paste the important email here for now.",
    };
  if (!c || c.status !== "active")
    return {
      ...base,
      availability: "needs_connection",
      description:
        "I am not watching your inbox. Connect Gmail with reading permission, then choose exact senders and enable an email watch in Household settings.",
    };
  if (!c.scopes.includes("https://www.googleapis.com/auth/gmail.readonly"))
    return {
      ...base,
      availability: "needs_permission",
      description:
        "I cannot scan or read your inbox yet. Gmail sending permission is separate from reading: connect reading access and explicitly enable a sender-specific watch in Household settings.",
    };
  if (!watch.enabled || !watch.permitted)
    return {
      ...base,
      availability: "needs_selection",
      description:
        "I am not watching your inbox. Gmail reading is connected, but you still need to enable or resume a watch for the exact senders you choose in Household settings.",
    };
  const checked = watch.lastCheckedAt
    ? ` The last completed check covered messages through ${new Date(watch.lastCheckedAt).toISOString()}.`
    : " The watch has not completed its first check yet.";
  return {
    ...base,
    availability: "available",
    description: `Your Gmail watch is enabled for your selected senders. Checks run about every 15 minutes and prepare drafts for review; they do not send messages or change calendars.${checked}${watch.issue ? " Its latest check needs attention; check Household settings." : ""} This does not scan Outlook, your whole inbox or your calendar.`,
  };
}

/** Safe for UI/model context: no source bodies, names, IDs, scopes, tokens or connection records. */
export function capabilityInventory(
  snapshot: CapabilitySnapshot,
): Capability[] {
  return [
    fixed(
      "household_tasks",
      "Household tasks",
      "Keep personal to-dos, due dates and child associations in Tasks. You can edit, finish, reopen or remove them." + (snapshot.mode === "connected" ? " Ask me to change a saved task, revise an existing request draft, cancel pending work or hide your request; I check its current version and ask which item when unclear. These actions do not undo provider results or approve external changes." : " Use the task controls to change saved work; conversational editing needs the connected assistant."),
    ),
    fixed(
      "calendar_drafts",
      "Calendar drafts",
      "Prepare an editable calendar change from the details you share. A draft or calendar-file download is not an event saved with a provider.",
    ),
    fixed(
      "email_drafts",
      "Email drafts",
      "Prepare editable email drafts using the details you provide. Copying or saving a draft does not send it.",
    ),
    fixed(
      "pickup_drafts",
      "Pickup drafts",
      "Prepare a pickup request for an eligible caregiver. A draft is not an agreed arrangement.",
    ),
    fixed(
      "library",
      "Saved files and work",
      "Keep photos, PDFs and prepared work in Library, organized by collection or child. Keeping a file does not mean its contents were read automatically.",
    ),
    fixed(
      "work_status",
      "Current work",
      "Show recorded task progress, decisions needed and results. Waiting, drafts and uncertain results stay separate from completed work.",
    ),
    {
      ...fixed(
        "family_memory",
        "Confirmed household memory",
        "Ask me to remember a household detail. You can review and edit a supported family fact before saving it; pending suggestions are not memory. Confirmed details are shared with your household and can be changed or removed. I do not learn new permissions or actions automatically." +
          (snapshot.mode === "connected"
            ? " With the configured model, I can suggest source-backed facts or reusable routines after you request learning. Suggestions stay private; sharing exact details, confirming facts and activating a routine each require review. Proposed routines start paused. A new-email routine stays private to you: review its condition and preparation instruction, then activate it separately with your existing Gmail consent. It never authorizes sending or calendar changes."
            : ""),
      ),
      requiresApproval: true,
    },
    fixed(
      "scheduled_preparation",
      "Routines and preparation",
      snapshot.mode === "device"
        ? "Schedule preparation for later, or review a daily or weekly routine that adds personal tasks or prepares drafts when Daymark is next open at or after the chosen time. Only the latest missed routine occurrence is prepared. Device work does not run while the app is closed or send anything automatically."
        : "Schedule preparation for later, or review a daily or weekly routine that adds personal tasks or prepares drafts after the app closes. You can also save a private routine describing which new Gmail messages matter and what to prepare; it starts paused and needs separate activation plus Gmail processing consent. Matching uses the model, not a required sender list. You can edit, pause or remove routines in Tasks; only the latest missed scheduled occurrence is prepared; external changes and messages still wait for your approval.",
      "available",
      snapshot.mode === "device" ? "workspace" : "server",
    ),
    cloudCapability(snapshot, "google", "calendar"),
    cloudCapability(snapshot, "microsoft", "calendar"),
    appleCapability(snapshot),
    cloudCapability(snapshot, "google", "email"),
    gmailDraftCapability(snapshot),
    cloudCapability(snapshot, "microsoft", "email"),
    {
      id: "caregiver_requests",
      label: "Caregiver arrangements",
      requiresApproval: true,
      location: "server",
      availability:
        snapshot.mode === "device"
          ? "needs_connection"
          : snapshot.caregiverDeliveryReady
            ? "available"
            : "needs_setup",
      description:
        snapshot.mode === "device"
          ? "I can draft a pickup request for you to copy and send. Confirmed caregiver arrangements need a connected workspace and a supported response channel."
          : snapshot.caregiverDeliveryReady
            ? "I can prepare a caregiver request, send it after your approval and track the response. Pickup is only arranged after the caregiver accepts."
            : "I can prepare a caregiver request. Its delivery channel still needs setup before I can send it after approval and track acceptance.",
    },
    emailWatchCapability(snapshot, "inbox_read"),
    calendarReadingCapability(snapshot),
    emailWatchCapability(snapshot, "proactive_monitoring"),
    fixed(
      "purchases",
      "Shopping and orders",
      "I cannot browse shops, buy items or place orders yet. You can keep a shopping to-do in Tasks and complete the purchase yourself.",
      "unsupported",
      "unavailable",
    ),
    fixed(
      "bookings",
      "Bookings and reservations",
      "I cannot book activities or make reservations yet. You can save the service and what you want help with under Request another connection in Household settings. That saves your request; it does not reserve a slot. Use the service’s own app or website for now.",
      "unsupported",
      "unavailable",
    ),
    fixed(
      "web_search",
      "Web search",
      "I cannot search the web or open arbitrary links yet. Paste the relevant information or keep the document in Library.",
      "unsupported",
      "unavailable",
    ),
    voiceCapability(snapshot),
  ];
}

type Topic = "overview" | "connections" | "calendar" | "email" | CapabilityId;
/** Deliberately narrow: a question mentioning a concrete job must reach preparation. */
function questionTopic(text: string): Topic | null {
  if (text.length > 200 || /[\n\r]/.test(text)) return null;
  const input = text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ");
  if (
    /^(?:help|help me|what can you do|what do you do|what are you able to do|what are your capabilities|how can you help(?: me)?|what can you help(?: me)? with|how does this work|what can i ask(?: you)?|show me what you can do)$/.test(
      input,
    )
  )
    return "overview";
  if (
    /^(?:what (?:apps|accounts|services|connectors) (?:can you use|can you connect to|are connected)|what are you connected to|what connections do you have)$/.test(
      input,
    )
  )
    return "connections";
  if (
    /^(?:are you|do you) (?:watching|watch|monitoring|monitor|scanning|scan) (?:my |our |the )?(?:email|emails|inbox|calendar|calendars)(?: (?:automatically|in the background))?$/.test(
      input,
    ) ||
    /^(?:are you proactive|can you (?:be proactive|work proactively|monitor things|work in the background))$/.test(
      input,
    )
  )
    return "proactive_monitoring";
  const prefix = "(?:can you|are you able to|do you)";
  if (
    new RegExp(
      `^${prefix} (?:read|scan|check|monitor|watch|search)(?: through)? (?:my |our |the )?(?:(?:school|gmail|outlook) )?(?:email|emails|inbox)(?: (?:automatically|for me))?$`,
    ).test(input)
  )
    return "inbox_read";
  if (
    new RegExp(
      `^${prefix} (?:read|sync|see|check|browse) (?:my |our |the )?(?:full |whole )?calendars?(?: (?:automatically|for me))?$`,
    ).test(input)
  )
    return "calendar_sync";
  if (
    new RegExp(
      `^${prefix} (?:use|connect to|work with) (?:my )?(?:apple calendar|icloud calendar|icloud)$`,
    ).test(input)
  )
    return "apple_calendar";
  if (
    new RegExp(
      `^${prefix} (?:use|connect to|work with) (?:my )?google calendar$`,
    ).test(input)
  )
    return "google_calendar";
  if (
    new RegExp(
      `^${prefix} (?:use|connect to|work with) (?:my )?(?:outlook|microsoft) calendar$`,
    ).test(input)
  )
    return "microsoft_calendar";
  if (
    new RegExp(
      `^${prefix} (?:use|connect to|send emails? (?:with|through|from)) (?:my )?gmail$`,
    ).test(input)
  )
    return "gmail_send";
  if (
    new RegExp(
      `^${prefix} (?:use|connect to|send emails? (?:with|through|from)) (?:my )?(?:outlook(?: email)?|microsoft email)$`,
    ).test(input)
  )
    return "outlook_send";
  if (
    new RegExp(
      `^${prefix} (?:manage|update|change|write to) (?:my |our |the )?calendar$`,
    ).test(input) ||
    new RegExp(
      `^${prefix} (?:add|edit|create|prepare) (?:calendar )?events?(?: (?:for me|to my calendar))?$`,
    ).test(input)
  )
    return "calendar";
  if (
    new RegExp(
      `^${prefix} (?:send|draft|write|prepare)(?: and send)? (?:school )?(?:emails?|replies|messages)(?: (?:for me|on my behalf))?$`,
    ).test(input)
  )
    return "email";
  if (
    new RegExp(
      `^${prefix} (?:arrange|coordinate|help with) (?:school )?pickups?(?: for me)?$`,
    ).test(input)
  )
    return "caregiver_requests";
  if (
    new RegExp(
      `^${prefix} (?:organize|manage|keep track of|help with|help me manage) (?:my |our |the )?(?:household|tasks|to-dos|todo list|shopping list)$`,
    ).test(input)
  )
    return "household_tasks";
  if (
    new RegExp(
      `^${prefix} (?:save|keep|organize) (?:my |our )?(?:photos|files|documents|media|pdfs)$`,
    ).test(input)
  )
    return "library";
  if (
    new RegExp(
      `^${prefix} (?:schedule (?:tasks|requests|preparation)|prepare (?:tasks|requests) later|(?:create|save|manage) (?:recurring )?routines)$`,
    ).test(input)
  )
    return "scheduled_preparation";
  if (
    new RegExp(
      `^${prefix} (?:remember (?:things|family details|household details|things about my family)|save (?:family |household )?memory)$`,
    ).test(input) ||
    /^what can you remember$/.test(input)
  )
    return "family_memory";
  if (
    new RegExp(
      `^${prefix} (?:buy|order|purchase) (?:things|items|school supplies|groceries)(?: for me)?$`,
    ).test(input) ||
    input === "can you shop for me"
  )
    return "purchases";
  if (
    new RegExp(
      `^${prefix} (?:book|reserve|make reservations for) (?:activities|classes|lessons|appointments|restaurants|things)(?: for me)?$`,
    ).test(input) ||
    /^(?:can you (?:make bookings|make reservations)|do you have (?:a|your own) browser)$/.test(
      input,
    )
  )
    return "bookings";
  if (
    new RegExp(`^${prefix} (?:search|browse) (?:the )?(?:web|internet)$`).test(
      input,
    ) ||
    input === "can you open links"
  )
    return "web_search";
  if (
    /^(?:do you (?:have|support) (?:voice|voice mode|dictation|speech to text)|can (?:you|we) (?:talk|speak)(?: (?:by voice|out loud))?|can i talk to you|can you transcribe (?:my voice|speech))$/.test(
      input,
    )
  )
    return "voice";
  return null;
}

/** Answers capabilities only, never approves an action or claims a new result. */
export function capabilityReply(
  text: string,
  snapshot: CapabilitySnapshot,
): string | null {
  const topic = questionTopic(text);
  if (!topic) return null;
  const inventory = capabilityInventory(snapshot);
  const get = (id: CapabilityId) => inventory.find((entry) => entry.id === id)!;
  const calendar =
    snapshot.mode === "device"
      ? get("apple_calendar")
      : get(
          snapshot.selected?.calendar === "google"
            ? "google_calendar"
            : snapshot.selected?.calendar === "microsoft"
              ? "microsoft_calendar"
              : "apple_calendar",
        );
  const calendarReply =
    snapshot.mode === "device" && calendar.availability !== "available"
      ? "I can prepare an editable calendar draft and save an approved event to this device’s plan. A calendar-file download still needs importing. For Apple Calendar, use the iPhone app, allow access and choose a calendar."
      : snapshot.mode === "connected" && !snapshot.selected?.calendar
        ? "I can prepare calendar changes. Choose a connected Google, Outlook or Apple calendar in Household settings before approving a save. This does not sync your full calendar."
        : calendar.description;
  const emailReply =
    snapshot.mode === "device"
      ? "I can prepare email drafts for you to review, copy and send yourself. Sending through Gmail or Outlook needs a connected workspace; nothing is sent from this device workspace."
      : get("gmail_send").availability === "available" &&
          !snapshot.selected?.email
        ? get("gmail_send").description
        : !snapshot.selected?.email
          ? "I can prepare email drafts. Connect Gmail or Outlook and choose your sending account in Household settings to send after your approval. Sending permission does not give me inbox access."
          : get(
              snapshot.selected.email === "google"
                ? "gmail_send"
                : "outlook_send",
            ).description;
  if (topic === "inbox_read" && /outlook|microsoft/i.test(text))
    return "I cannot scan or read your Outlook inbox yet. Private email assistance currently supports Gmail; Outlook sending permission is separate from reading.";
  if (topic === "proactive_monitoring" && /calendar/i.test(text))
    return get("calendar_sync").description;
  if (topic === "calendar") return calendarReply;
  if (topic === "email") return emailReply;
  if (topic === "connections")
    return `${calendarReply} ${emailReply} For another service, save what you need under Request another connection in Household settings. A saved request does not connect an account.`;
  if (topic === "overview") {
    const connected = inventory.some(
      (entry) =>
        [
          "google_calendar",
          "microsoft_calendar",
          "apple_calendar",
          "gmail_send",
          "outlook_send",
        ].includes(entry.id) && entry.availability === "available",
    );
    const connectionSummary = connected
      ? "I can also use your available connections for the specific changes you review and approve."
      : snapshot.mode === "device"
        ? "Here, I can prepare drafts for you to review, copy and send; approved calendar drafts can stay in your device plan."
        : "Connected accounts are needed to apply calendar changes or send email after your approval.";
    const emailHelp = snapshot.mailbox
      ? get("inbox_read").availability === "available"
        ? "Your private Gmail help can check and search email across senders, with bounded source coverage. Sharing and writes wait for your review."
        : "Connect and enable private Gmail help in Household settings before I can check your email."
      : snapshot.emailWatch?.enabled && snapshot.emailWatch.permitted
        ? "Your Gmail watch can prepare work from selected senders; nothing it finds is sent without approval."
        : "Gmail needs separate reading permission and explicit private email consent before I can check it.";
    return `I can help keep the household organized: personal tasks, calendar and email drafts, pickup requests, routines, confirmed family details, and saved photos or documents. ${connectionSummary} I can show what is waiting on you and what is still in progress. ${emailHelp} ${get("calendar_sync").availability === "available" ? "Your selected private calendar windows can also inform planning; coverage and freshness remain limited." : "Calendar reading needs its own connection and consent."} I cannot buy things or complete website bookings yet.`;
  }
  return get(topic).description;
}
