import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import {
  canSendGmail,
  canWriteGoogleCalendar,
} from "../shared/googlePermissions";
export const providerOf = (c: Pick<Doc<"connections">, "provider">) =>
  c.provider ?? "google";
export function canUse(
  c:
    | Pick<Doc<"connections">, "provider" | "status" | "scopes" | "calendarId">
    | null
    | undefined,
  purpose: "calendar" | "email",
) {
  if (!c || c.status !== "active" || (purpose === "calendar" && !c.calendarId))
    return false;
  if (providerOf(c) === "apple")
    return purpose === "calendar" && c.scopes.includes("calendar.local.full");
  if (providerOf(c) === "google")
    return purpose === "email"
      ? canSendGmail(c.scopes)
      : canWriteGoogleCalendar(c.scopes);
  const scope =
    providerOf(c) === "microsoft"
      ? purpose === "calendar"
        ? "Calendars.ReadWrite"
        : "Mail.Send"
      : `https://www.googleapis.com/auth/${purpose === "calendar" ? "calendar.app.created" : "gmail.send"}`;
  return c.scopes.some((s) => s.toLowerCase() === scope.toLowerCase());
}
export async function selection(
  ctx: QueryCtx,
  subject: string,
  purpose: "calendar" | "email",
) {
  const preference = await ctx.db
    .query("connectionPreferences")
    .withIndex("by_subject", (q) => q.eq("subject", subject))
    .unique();
  const id =
    purpose === "calendar"
      ? preference?.calendarConnectionId
      : preference?.emailConnectionId;
  // Pre-migration records retain their original Google destination until a choice is saved.
  const connection = id
    ? await ctx.db.get(id)
    : preference
      ? null
      : ((
          await ctx.db
            .query("connections")
            .withIndex("by_subject", (q) => q.eq("subject", subject))
            .collect()
        ).find((c) => providerOf(c) === "google") ?? null);
  return { connection, version: preference?.version ?? 0 };
}
