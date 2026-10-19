import { z } from "zod";
import {
  calendarSchema,
  emailSchema,
  pickupSchema,
  type Payload,
} from "./daymark.js";
import { canSendGmail, canWriteGoogleCalendar } from "./googlePermissions.js";

export type ToolProvider = "google" | "microsoft" | "apple";
export type ToolDefinition = {
  name: string;
  version: 1;
  classification: "prepare" | "commit";
  location: "server" | "iphone" | "synthetic_browser";
  adapter:
    "approved_provider_action" | "approved_native_calendar" | "unavailable";
  kind: "calendar" | "email" | "pickup" | "booking";
  provider?: ToolProvider;
  grant: string | null;
  verification:
    | "calendar_readback"
    | "provider_acceptance"
    | "caregiver_response"
    | "synthetic_reservation_readback";
  approval: "exact_action_revision" | "none";
  limits: {
    maxArgumentBytes: number;
    maxAttemptsPerApproval: number;
    maxAdapterCalls: 1;
  };
};
const limits = {
  maxArgumentBytes: 64_000,
  maxAttemptsPerApproval: 8,
  maxAdapterCalls: 1 as const,
};
function commit(
  name: string,
  kind: ToolDefinition["kind"],
  grant: string | null,
  verification: ToolDefinition["verification"],
  provider?: ToolProvider,
): ToolDefinition {
  return {
    name,
    version: 1,
    classification: "commit",
    location: provider === "apple" ? "iphone" : "server",
    adapter:
      provider === "apple"
        ? "approved_native_calendar"
        : "approved_provider_action",
    kind,
    ...(provider ? { provider } : {}),
    grant,
    verification,
    approval: "exact_action_revision",
    limits,
  };
}
/** This is a closed product allowlist, not a model-selected adapter or arbitrary URL router. */
export const toolRegistry: readonly ToolDefinition[] = Object.freeze(
  (
    [
      commit(
        "calendar.google.commit",
        "calendar",
        "https://www.googleapis.com/auth/calendar.app.created",
        "calendar_readback",
        "google",
      ),
      commit(
        "calendar.microsoft.commit",
        "calendar",
        "Calendars.ReadWrite",
        "calendar_readback",
        "microsoft",
      ),
      commit(
        "calendar.apple.commit",
        "calendar",
        "calendar.local.full",
        "calendar_readback",
        "apple",
      ),
      commit(
        "email.google.send",
        "email",
        "https://www.googleapis.com/auth/gmail.send",
        "provider_acceptance",
        "google",
      ),
      commit(
        "email.microsoft.send",
        "email",
        "Mail.Send",
        "provider_acceptance",
        "microsoft",
      ),
      commit("caregiver.gmail.request", "pickup", "https://www.googleapis.com/auth/gmail.send", "caregiver_response", "google"),
      commit("caregiver.email.request", "pickup", null, "caregiver_response"),
      commit("caregiver.app.request", "pickup", null, "caregiver_response"),
      {
        ...commit(
          "booking.synthetic.commit",
          "booking",
          null,
          "synthetic_reservation_readback",
        ),
        location: "synthetic_browser",
        adapter: "unavailable",
      },
      {
        ...commit(
          "booking.synthetic.prepare",
          "booking",
          null,
          "synthetic_reservation_readback",
        ),
        classification: "prepare",
        approval: "none",
        location: "synthetic_browser",
        adapter: "unavailable",
      },
    ] satisfies ToolDefinition[]
  ).map((definition) =>
    Object.freeze({
      ...definition,
      limits: Object.freeze({ ...definition.limits }),
    }),
  ),
);

export function registeredTool(name: string, version: number): ToolDefinition {
  const definition = toolRegistry.find(
    (tool) => tool.name === name && tool.version === version,
  );
  if (!definition)
    throw new Error(
      "This tool or tool version is not supported. Review the request again.",
    );
  return definition;
}
const strictPayload = z.discriminatedUnion("kind", [
  calendarSchema.strict(),
  emailSchema
    .extend({
      attachments: z
        .array(
          z
            .object({
              id: z.string(),
              name: z.string().max(200),
              hash: z.string(),
            })
            .strict(),
        )
        .max(5)
        .optional(),
    })
    .strict(),
  pickupSchema
    .extend({ calendarUpdate: calendarSchema.strict().optional() })
    .strict(),
]);
export type ToolSelection = {
  provider?: string;
  deliveryChannel?: string;
  emailTransport?: string;
  toolName?: string;
  toolVersion?: number;
};
/** Selection comes from a stored approval. A model cannot pick its own implementation. */
export function resolveApprovedTool(
  raw: unknown,
  approval: ToolSelection,
): { tool: ToolDefinition; payload: Payload } {
  const payload = strictPayload.parse(raw);
  if (
    approval.provider !== undefined &&
    !["google", "microsoft", "apple"].includes(approval.provider)
  )
    throw new Error("This provider has no approved tool.");
  let name: string;
  if (payload.kind === "pickup") {
    if (
      (approval.provider !== undefined && !(approval.provider === "google" && approval.emailTransport === "gmail")) ||
      (approval.emailTransport !== undefined && !["gmail", "resend"].includes(approval.emailTransport)) ||
      (approval.emailTransport === "gmail" && approval.deliveryChannel !== "email") ||
      (approval.deliveryChannel !== undefined &&
        !["email", "app"].includes(approval.deliveryChannel))
    )
      throw new Error("This caregiver delivery tool is not supported.");
    name = approval.emailTransport === "gmail" ? "caregiver.gmail.request" : `caregiver.${approval.deliveryChannel ?? "email"}.request`;
  } else {
    if (approval.deliveryChannel !== undefined)
      throw new Error("A caregiver delivery choice cannot select this tool.");
    const provider = approval.provider ?? "google"; // Existing Google approvals predate the provider field.
    name =
      payload.kind === "calendar"
        ? `calendar.${provider}.commit`
        : `email.${provider}.send`;
  }
  if (approval.toolName !== undefined && approval.toolName !== name)
    throw new Error(
      "The approved tool no longer matches these action details.",
    );
  const tool = registeredTool(name, approval.toolVersion ?? 1);
  if (tool.adapter === "unavailable")
    throw new Error("This tool has no approved execution adapter.");
  assertToolBudget(tool, {
    argumentBytes: new TextEncoder().encode(JSON.stringify(raw)).length,
    previousAttempts: 0,
    adapterCalls: 1,
  });
  return { tool, payload };
}
export function assertToolBudget(
  tool: ToolDefinition,
  budget: {
    argumentBytes: number;
    previousAttempts: number;
    adapterCalls: number;
  },
) {
  const values = [
    budget.argumentBytes,
    budget.previousAttempts,
    budget.adapterCalls,
  ];
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    budget.argumentBytes > tool.limits.maxArgumentBytes ||
    budget.previousAttempts >= tool.limits.maxAttemptsPerApproval ||
    budget.adapterCalls !== 1
  )
    throw new Error(
      "This tool reached its execution limit. Review the request before trying again.",
    );
}
/** Extra defense around the grant already enforced at claim and immediately before dispatch. */
export function validateToolGrant(
  tool: ToolDefinition,
  connection: {
    provider?: string;
    status: string;
    scopes: string[];
    calendarId?: string;
    nativeDeviceId?: string;
  } | null,
  destination: string,
  nativeDeviceId?: string,
) {
  if (!destination.trim())
    throw new Error("The approved destination is missing.");
  if (!tool.provider) return; // Caregiver eligibility and delivery are validated against household records.
  const granted =
    connection &&
    ((tool.name === "email.google.send" || tool.name === "caregiver.gmail.request")
      ? canSendGmail(connection.scopes)
      : tool.name === "calendar.google.commit"
        ? canWriteGoogleCalendar(connection.scopes)
        : tool.grant &&
          connection.scopes.some(
            (scope) => scope.toLowerCase() === tool.grant!.toLowerCase(),
          ));
  if (
    !connection ||
    connection.status !== "active" ||
    (connection.provider ?? "google") !== tool.provider ||
    !granted
  )
    throw new Error(
      "The approved tool no longer has the required account permission.",
    );
  if (tool.kind === "calendar" && connection.calendarId !== destination)
    throw new Error("The approved calendar destination changed.");
  if (
    tool.provider === "apple" &&
    (!nativeDeviceId || connection.nativeDeviceId !== nativeDeviceId)
  )
    throw new Error("This calendar tool belongs to another iPhone.");
}
