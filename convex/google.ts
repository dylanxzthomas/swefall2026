"use node";
import { withMicrosoft, MicrosoftConnectionBusy } from "./microsoft";
import {
  writeMicrosoftCalendar,
  readMicrosoftCalendar,
  sameMicrosoftEvent,
  sendMicrosoftEmail,
  microsoftEmailBody,
  microsoftEventDraft,
} from "./microsoftAdapter";
import { randomBytes } from "node:crypto";
import { calendar } from "@googleapis/calendar";
import { OAuth2Client } from "google-auth-library";
import type { Credentials } from "google-auth-library";
import { v, ConvexError } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { hash, eventBody, sameEvent, payloadSchema } from "../shared/daymark";
import { seal, unseal } from "./googleCrypto";
import { googleConnectionConfigured } from "./providerConfiguration";
import {
  writeCalendar,
  sendEmail,
  providerCode,
  ReviewRequired,
  Unconfirmed,
} from "./googleAdapter";
const calendarScope = "https://www.googleapis.com/auth/calendar.app.created";
export class ConnectionBusy extends Error {}
import { gmailReadScope } from "../shared/emailWatches";
import { gmailComposeScope } from "../shared/mailbox";
import { googleCalendarEventsScope } from "../shared/googlePermissions";
const scopeFor = (purpose: string) =>
  purpose === "calendar_read"
    ? "https://www.googleapis.com/auth/calendar.readonly"
    : purpose === "calendar"
      ? calendarScope
      : purpose === "calendar_events"
        ? googleCalendarEventsScope
        : purpose === "watch"
          ? gmailReadScope
          : purpose === "compose"
            ? gmailComposeScope
            : gmailScope;
const gmailScope = "https://www.googleapis.com/auth/gmail.send";
function oauth() {
  if (!googleConnectionConfigured() || !process.env.CONVEX_SITE_URL)
    throw new ConvexError("Google connection is not securely configured yet.");
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.CONVEX_SITE_URL}/google/callback`,
  );
}
const binding = (c: { householdId: string; subject: string }) =>
  `${c.householdId}:${c.subject}`;
export const connect = action({
  args: {
    purpose: v.union(
      v.literal("calendar_read"),
      v.literal("calendar_events"),
      v.literal("calendar"),
      v.literal("gmail"),
      v.literal("watch"),
      v.literal("compose"),
    ),
    native: v.boolean(),
  },
  handler: async (ctx, args): Promise<string> => {
    if (!(await ctx.auth.getUserIdentity()))
      throw new ConvexError("Sign in first.");
    if (
      process.env.DAYMARK_ENVIRONMENT !== "production" &&
      !(process.env.DAYMARK_TEST_GOOGLE_EMAILS ?? "")
        .split(",")
        .some((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
    )
      throw new ConvexError(
        "The app owner needs to configure a dedicated Google test account first.",
      );
    const auth = oauth(),
      state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(48).toString("base64url");
    await ctx.runMutation(internal.connections.begin, {
      hash: hash(state),
      verifier: seal(verifier, hash(state)),
      purpose: args.purpose,
      native: args.native,
    });
    return auth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      state,
      scope: ["openid", "email", scopeFor(args.purpose)],
      code_challenge: Buffer.from(hash(verifier), "hex").toString("base64url"),
      code_challenge_method: "S256" as any,
    });
  },
});
export const callback = internalAction({
  args: { state: v.string(), code: v.optional(v.string()) },
  handler: async (ctx, args): Promise<string> => {
    const {
      state,
      connection: c,
      timezone,
    } = await ctx.runMutation(internal.connections.consume, {
      hash: hash(args.state),
    });
    const returnTo = state.native
      ? "com.dylanxzthomas.wren://google/return"
      : process.env.DAYMARK_WEB_URL;
    if (
      !returnTo ||
      (!state.native &&
        !/^https:\/\//.test(returnTo) &&
        !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(returnTo))
    )
      throw new Error("Trusted return URL missing.");
    if (!args.code) return `${returnTo}?connection=cancelled`;
    const auth = oauth();
    const { tokens } = await auth.getToken({
      code: args.code,
      codeVerifier: unseal<string>(state.verifier, hash(args.state)),
    });
    if (!tokens.id_token) throw new Error("Verified Google identity missing.");
    const identity = (
      await auth.verifyIdToken({
        idToken: tokens.id_token,
        audience: process.env.GOOGLE_CLIENT_ID!,
      })
    ).getPayload();
    if (!identity?.email || !identity.email_verified)
      throw new Error("Verified Google email required.");
    if (
      process.env.DAYMARK_ENVIRONMENT !== "production" &&
      !(process.env.DAYMARK_TEST_GOOGLE_EMAILS ?? "")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .includes(identity.email.toLowerCase())
    )
      throw new Error(
        "Use an explicitly allowlisted dedicated Google test account in this environment.",
      );
    if (
      c.email &&
      c.email !== identity.email &&
      !["revoked", "disconnected", "revocation_unconfirmed"].includes(c.status)
    )
      throw new Error(
        "Disconnect the previous Google account before changing accounts.",
      );
    const sameAccount = c.email === identity.email;
    const previous =
      c.cipher && sameAccount ? unseal<Credentials>(c.cipher, binding(c)) : {};
    const credentials = {
      ...previous,
      ...tokens,
      refresh_token: tokens.refresh_token ?? previous.refresh_token,
    };
    if (!credentials.refresh_token)
      throw new Error(
        "Offline Google consent is required. Reconnect with consent.",
      );
    const scopes = (tokens.scope ?? "").split(" ");
    if (!scopes.includes(scopeFor(state.purpose)))
      throw new Error("Requested Google permission was not granted.");
    auth.setCredentials({ access_token: credentials.access_token });
    let calendarId = sameAccount ? c.calendarId : undefined;
    if (state.purpose === "calendar" && !calendarId) {
      // Explicitly authorized by the UI's “Connect & create Daymark calendar” action. Never auto-retry creation.
      const calendarResult = await calendar({
        version: "v3",
        auth,
      }).calendars.insert(
        {
          requestBody: {
            summary: "Daymark",
            timeZone: timezone,
            description: "Calendar changes reviewed and approved in Daymark.",
          },
        },
        { timeout: 25_000, retry: false },
      );
      if (!calendarResult.data.id)
        throw new Error("Calendar creation returned no ID.");
      calendarId = calendarResult.data.id;
    }
    const saved = await ctx.runMutation(internal.connections.connected, {
      id: c._id,
      version: state.connectionVersion,
      cipher: seal(credentials, binding(c)),
      scopes,
      email: identity.email,
      ...(calendarId ? { calendarId } : {}),
    });
    if (!saved)
      throw new Error(
        "Connection changed during consent. Open Daymark to reconnect.",
      );
    return `${returnTo}?connection=connected`;
  },
});
export async function withGoogle<T>(
  ctx: ActionCtx,
  approval: Pick<Doc<"approvals">, "connectionId" | "connectionVersion">,
  fn: (auth: OAuth2Client) => Promise<T>,
) {
  if (!approval.connectionId || approval.connectionVersion === undefined)
    throw new Error("Google connection missing.");
  const lock = randomBytes(20).toString("hex");
  const c = await ctx.runMutation(internal.connections.acquire, {
    id: approval.connectionId,
    version: approval.connectionVersion,
    lock,
  });
  if (!c?.cipher) {
    const current = await ctx.runQuery(internal.connections.privateRecord, {
      id: approval.connectionId,
    });
    if (
      current?.status === "active" &&
      current.version === approval.connectionVersion &&
      (current.lockUntil ?? 0) > Date.now()
    )
      throw new ConnectionBusy();
    throw new ReviewRequired(
      "Google connection changed. Reconnect and review again.",
    );
  }
  let reconnect = false;
  try {
    let credentials = unseal<Credentials>(c.cipher, binding(c));
    const client = oauth();
    if (
      !credentials.access_token ||
      (credentials.expiry_date ?? 0) < Date.now() + 60_000
    ) {
      client.setCredentials(credentials);
      try {
        const refreshed = await client.refreshAccessToken();
        credentials = {
          ...credentials,
          ...refreshed.credentials,
          refresh_token:
            refreshed.credentials.refresh_token ?? credentials.refresh_token,
        };
      } catch (e) {
        reconnect = providerCode(e) === 400 || providerCode(e) === 401;
        throw e;
      }
      if (
        !(await ctx.runMutation(internal.connections.refreshed, {
          id: c._id,
          version: c.version,
          lock,
          cipher: seal(credentials, binding(c)),
          ...(credentials.scope
            ? { scopes: credentials.scope.split(" ").filter(Boolean) }
            : {}),
        }))
      )
        throw new ReviewRequired(
          "Google access or permissions changed during refresh. Reconnect and review again.",
        );
    }
    // Access-token-only client prevents hidden refresh/retry during non-idempotent sends.
    client.setCredentials({ access_token: credentials.access_token });
    return await fn(client);
  } catch (e) {
    if (providerCode(e) === 401) reconnect = true;
    throw e;
  } finally {
    await ctx.runMutation(internal.connections.release, {
      id: c._id,
      lock,
      reconnect,
    });
  }
}
export const execute = internalAction({
  args: { actionId: v.id("actions"), approvalId: v.id("approvals") },
  handler: async (ctx, args): Promise<void> => {
    const snapshot = await ctx.runQuery(internal.execution.snapshot, {
      actionId: args.actionId,
    });
    if (snapshot?.approval?.provider === "apple") return; // The approving iPhone executes EventKit work.
    const claim = await ctx.runMutation(internal.execution.claim, args);
    if (!claim) return;
    const { action: a, approval, attemptId } = claim;
    let dispatched = false;
    const dispatch = async () => {
      dispatched = await ctx.runMutation(internal.execution.dispatch, {
        attemptId,
      });
      return dispatched;
    };
    try {
      const payload = payloadSchema.parse(a.payload);
      if (payload.kind === "pickup") {
        await ctx.runAction(approval.emailTransport === "gmail" ? internal.pickupMailWorker.send : internal.pickups.send, {
          actionId: a._id,
          attemptId,
        });
        return;
      }
      if (approval.provider === "microsoft") {
        await withMicrosoft(
          ctx,
          approval.connectionId!,
          approval.connectionVersion!,
          async (token) => {
            if (payload.kind === "calendar") {
              const receipt = await writeMicrosoftCalendar(
                token,
                approval.destination,
                a._id,
                a.revision,
                payload,
                a.before,
                dispatch,
              );
              if (!receipt || (!dispatched && !(await dispatch()))) return;
              await ctx.runMutation(internal.execution.finish, {
                attemptId,
                status: "succeeded",
                providerId: receipt.eventId,
                etag: receipt.etag,
                ...(receipt.url ? { url: receipt.url } : {}),
              });
            } else {
              const files = [];
              for (const file of await ctx.runQuery(
                internal.emailFiles.forAction,
                { actionId: a._id },
              )) {
                const blob = await ctx.storage.get(file.storageId);
                if (!blob)
                  throw new ReviewRequired(
                    "An approved attachment expired. Review again.",
                  );
                files.push({
                  name: file.name,
                  mediaType: file.mediaType,
                  data: new Uint8Array(await blob.arrayBuffer()),
                });
              }
              microsoftEmailBody(payload, a._id, files);
              if (!(await dispatch())) return;
              const receipt = await sendMicrosoftEmail(
                token,
                payload,
                a._id,
                files,
              );
              await ctx.runMutation(internal.execution.finish, {
                attemptId,
                status: "succeeded",
                outcome: "microsoft_accepted",
                ...(receipt.requestId ? { requestId: receipt.requestId } : {}),
              });
            }
          },
        );
        return;
      }
      await withGoogle(ctx, approval, async (auth) => {
        if (payload.kind === "calendar") {
          const receipt = await writeCalendar(
            auth,
            approval.destination,
            a._id,
            a.revision,
            payload,
            a.before,
            dispatch,
          );
          if (!receipt) return;
          if (!dispatched && !(await dispatch())) return;
          await ctx.runMutation(internal.execution.finish, {
            attemptId,
            status: "succeeded",
            providerId: receipt.eventId,
            etag: receipt.etag,
            ...(receipt.url ? { url: receipt.url } : {}),
          });
        } else {
          const files = [];
          for (const file of await ctx.runQuery(internal.emailFiles.forAction, {
            actionId: a._id,
          })) {
            const blob = await ctx.storage.get(file.storageId);
            if (!blob)
              throw new ReviewRequired(
                "An approved attachment expired. Review again.",
              );
            files.push({
              name: file.name,
              mediaType: file.mediaType,
              data: new Uint8Array(await blob.arrayBuffer()),
            });
          }
          if (!(await dispatch())) return;
          const messageId = await sendEmail(auth, payload, a._id, files);
          await ctx.runMutation(internal.execution.finish, {
            attemptId,
            status: "succeeded",
            providerId: messageId,
          });
        }
      });
    } catch (e) {
      if (
        (e instanceof ConnectionBusy || e instanceof MicrosoftConnectionBusy) &&
        !dispatched
      ) {
        await ctx.runMutation(internal.execution.defer, { attemptId });
        return;
      }
      const code = providerCode(e),
        knownRejected =
          code >= 400 && code < 500 && ![408, 409, 429].includes(code);
      const status =
        e instanceof ReviewRequired
          ? "review"
          : e instanceof Unconfirmed || (dispatched && !knownRejected)
            ? "uncertain"
            : "failed";
      const error =
        e instanceof ReviewRequired || e instanceof Unconfirmed
          ? e.message
          : code === 401 || code === 403
            ? "Account access needs attention. Reconnect and review this action."
            : status === "uncertain"
              ? "The provider may have accepted this action. Do not resend. Check the calendar or Sent Mail."
              : "The action stopped before a confirmed provider result. Nothing is marked complete; review to try again.";
      await ctx.runMutation(internal.execution.finish, {
        attemptId,
        status,
        error,
      });
    }
  },
});
export const reconcile = internalAction({
  args: { actionId: v.id("actions") },
  handler: async (ctx, args): Promise<void> => {
    const snapshot = await ctx.runQuery(internal.execution.snapshot, args);
    if (
      !snapshot?.approval ||
      snapshot.action.status !== "uncertain" ||
      snapshot.action.payload.kind !== "calendar" ||
      !snapshot.action.attemptId
    )
      return;
    const { action: a, approval } = snapshot;
    if (approval.provider === "apple") return; // Reconciliation is a read on the originating iPhone.
    try {
      if (approval.provider === "microsoft") {
        await withMicrosoft(
          ctx,
          approval.connectionId!,
          approval.connectionVersion!,
          async (token) => {
            const event = await readMicrosoftCalendar(
              token,
              approval.destination,
              a._id,
              a.before,
            );
            if (a.payload.operation === "delete") {
              if (!event && a.before)
                await ctx.runMutation(internal.execution.reconciled, {
                  actionId: a._id,
                  providerId: a.before.eventId,
                  etag: a.before.etag,
                });
              return;
            }
            if (!event) {
              await ctx.runMutation(internal.execution.calendarMissing, args);
              return;
            }
            if (
              !event.id ||
              !event["@odata.etag"] ||
              !sameMicrosoftEvent(event, a.payload, a._id, a.revision)
            )
              return;
            await ctx.runMutation(internal.execution.reconciled, {
              actionId: a._id,
              providerId: event.id,
              etag: event["@odata.etag"],
              ...(event.webLink ? { url: event.webLink } : {}),
            });
          },
        );
        return;
      }
      await withGoogle(ctx, approval, async (auth) => {
        const id = a.before?.eventId ?? `d${hash(a._id)}`;
        const event = (
          await calendar({ version: "v3", auth }).events.get(
            { calendarId: approval.destination, eventId: id },
            { timeout: 25_000, retry: false },
          )
        ).data;
        if (a.payload.operation === "delete") {
          if (event.status === "cancelled")
            await ctx.runMutation(internal.execution.reconciled, {
              actionId: a._id,
              providerId: id,
              etag: a.before?.etag ?? "deleted",
            });
          return;
        }
        if (
          !sameEvent(event, eventBody(a.payload, a._id, a.revision)) ||
          !event.etag
        )
          return;
        await ctx.runMutation(internal.execution.reconciled, {
          actionId: a._id,
          providerId: id,
          etag: event.etag,
          ...(event.htmlLink ? { url: event.htmlLink } : {}),
        });
      });
    } catch (e) {
      if (
        approval.provider !== "microsoft" &&
        (providerCode(e) === 404 || providerCode(e) === 410)
      ) {
        if (
          snapshot.action.payload.operation === "delete" &&
          snapshot.action.before
        )
          await ctx.runMutation(internal.execution.reconciled, {
            ...args,
            providerId: snapshot.action.before.eventId,
            etag: snapshot.action.before.etag,
          });
        else await ctx.runMutation(internal.execution.calendarMissing, args);
      } /* Other failures remain uncertain. */
    }
  },
});
export const revoke = internalAction({
  args: { id: v.id("connections"), version: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const c = await ctx.runQuery(internal.connections.privateRecord, {
      id: args.id,
    });
    if (!c?.cipher || c.version !== args.version) return;
    let revoked = false;
    try {
      const tokens = unseal<Credentials>(c.cipher, binding(c));
      await oauth().revokeToken(tokens.refresh_token ?? tokens.access_token!);
      revoked = true;
    } catch {
      /* UI records unconfirmed provider revocation. */
    }
    await ctx.runMutation(internal.connections.erase, { ...args, revoked });
  },
});
export const refreshCalendar = action({
  args: { actionId: v.id("actions") },
  handler: async (ctx, args): Promise<void> => {
    const { api } = await import("./_generated/api");
    const current = await ctx.runQuery(api.jobs.calendarRefreshContext, args);
    if (current.provider === "apple")
      throw new ConvexError("Refresh this event on the connected iPhone.");
    if (current.provider === "microsoft") {
      await withMicrosoft(
        ctx,
        current.connectionId,
        current.connectionVersion,
        async (token) => {
          const event = await readMicrosoftCalendar(
            token,
            current.calendarId,
            args.actionId,
            { eventId: current.eventId },
          );
          if (!event || !event["@odata.etag"])
            throw new ConvexError(
              "This event was deleted. Prepare a new addition if needed.",
            );
          const payload = microsoftEventDraft(event, current.payload);
          await ctx.runMutation(internal.jobs.refreshedBefore, {
            ...args,
            revision: current.revision,
            etag: event["@odata.etag"],
            payload,
          });
        },
      );
      return;
    }
    const connection = {
      connectionId: current.connectionId,
      connectionVersion: current.connectionVersion,
    } as Doc<"approvals">;
    await withGoogle(ctx, connection, async (auth) => {
      const event = (
        await calendar({ version: "v3", auth }).events.get(
          { calendarId: current.calendarId, eventId: current.eventId },
          { timeout: 25_000, retry: false },
        )
      ).data;
      if (!event.etag || event.status === "cancelled")
        throw new ConvexError(
          "This event was deleted. Prepare a new calendar addition if needed.",
        );
      const { Temporal } = await import("@js-temporal/polyfill");
      const local = (value: string) =>
        Temporal.Instant.from(value).toZonedDateTimeISO(current.timezone);
      const allDay = Boolean(event.start?.date),
        start = event.start?.dateTime ? local(event.start.dateTime) : null,
        end = event.end?.dateTime ? local(event.end.dateTime) : null;
      await ctx.runMutation(internal.jobs.refreshedBefore, {
        ...args,
        revision: current.revision,
        etag: event.etag,
        payload: {
          kind: "calendar",
          title: event.summary ?? "",
          childId: null,
          date: allDay ? event.start!.date! : start!.toPlainDate().toString(),
          endDate: allDay
            ? Temporal.PlainDate.from(event.end!.date!)
                .subtract({ days: 1 })
                .toString()
            : end!.toPlainDate().toString(),
          startTime: start?.toPlainTime().toString().slice(0, 5) ?? null,
          endTime: end?.toPlainTime().toString().slice(0, 5) ?? null,
          allDay,
          timezone: current.timezone,
          location: event.location ?? "",
          notes: event.description ?? "",
          evidence: {},
          targetId: null,
        },
      });
    });
  },
});

/** Provider metadata establishes writability; neither the model nor submitted calendar labels are trusted. */
export const selectCalendar = action({
  args: {
    connectionId: v.id("connections"),
    connectionVersion: v.number(),
    selectionVersion: v.number(),
    calendarId: v.string(),
  },
  handler: async (ctx, args): Promise<number> => {
    const context = await ctx.runQuery(
      internal.calendarFeeds.destinationContext,
      {
        connectionId: args.connectionId,
        connectionVersion: args.connectionVersion,
        selectionVersion: args.selectionVersion,
      },
    );
    if (context.provider !== "google")
      throw new ConvexError("Choose a Google calendar for this connection.");
    if (!args.calendarId.trim() || args.calendarId.length > 1024)
      throw new ConvexError("Choose a valid calendar.");
    const selected = await withGoogle(ctx, args, async (auth) => {
      const { data } = await calendar({ version: "v3", auth }).calendarList.get(
        { calendarId: args.calendarId },
        { timeout: 25_000, retry: false },
      );
      if (
        !data.id ||
        data.deleted ||
        !["writer", "owner"].includes(data.accessRole ?? "")
      )
        throw new ConvexError(
          "This Google calendar is not writable. Choose another calendar.",
        );
      return {
        calendarId: data.id,
        calendarName: (data.summary || "Google Calendar").slice(0, 200),
      };
    });
    return ctx.runMutation(internal.calendarFeeds.selectDestination, {
      connectionId: args.connectionId,
      connectionVersion: args.connectionVersion,
      selectionVersion: args.selectionVersion,
      ...selected,
    });
  },
});
