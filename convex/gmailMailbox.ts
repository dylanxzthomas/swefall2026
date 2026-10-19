"use node";
import { randomBytes } from "node:crypto";
import { gmail, type gmail_v1 } from "@googleapis/gmail";
import type { OAuth2Client } from "google-auth-library";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { withGoogle, ConnectionBusy } from "./google";
import { providerCode, ReviewRequired } from "./googleAdapter";
import { mailboxFailure, type MailboxFailure } from "../shared/mailboxFailures";
import { exactSender } from "../shared/emailWatches";
import { decodeGmailSubject, gmailReplyRouting, type GmailReplyRouting } from "../shared/gmailReply";
import { extractGmailMessage } from "../shared/gmailMessage";
import {
  mailboxBatchSize,
  mailboxQuery,
  type MailboxRequest,
  type MailboxExtraction,
} from "../shared/mailbox";

export type MailboxWindow = {
  maxReads?: number;
  accountEmail?: string;
  request: MailboxRequest;
  from: number;
  through: number;
  pageToken?: string;
  historyId?: string;
  baselineHistoryId?: string;
  pendingProviderIds?: string[];
  mode?: string;
  run?: { mode?: string; resultHistoryId?: string };
};
export type ReadMail = {
  providerId: string;
  threadId?: string;
  replyRouting?: GmailReplyRouting;
  sender: string;
  subject: string;
  receivedAt: number;
  text: string;
  extraction: MailboxExtraction;
  labels: string[];
};
const opts = { timeout: 10_000, retry: false, maxContentLength: 1024 * 1024 };
const opaqueId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 200 &&
  /^[^\s\u0000-\u001f\u007f]+$/u.test(value);
const historyIdValid = (value: unknown): value is string =>
  typeof value === "string" && /^\d{1,30}$/.test(value);
export class MailboxResync extends Error {
  constructor(public readonly history = false) {
    super(
      history
        ? "Mailbox history needs a new baseline."
        : "Mailbox page needs to restart.",
    );
  }
}
function cursorFailure(error: unknown) {
  const e = error as {
    response?: {
      data?: {
        error?: {
          message?: string;
          errors?: { location?: string; message?: string }[];
        };
      };
    };
  };
  const info = e.response?.data?.error;
  return (
    providerCode(error) === 400 &&
    (/(invalid|expired).{0,80}page.?token|page.?token.{0,80}(invalid|expired)/i.test(
      info?.message ?? "",
    ) ||
      info?.errors?.some((v) => v.location === "pageToken"))
  );
}
/** All reads are account-bound; request/search text is never a URL or executable command. */
export async function readMailboxBatch(
  auth: OAuth2Client,
  window: MailboxWindow,
  permitted: () => Promise<boolean>,
  stage: (value: MailboxFailure["stage"]) => void = () => {},
) {
  const api = gmail({ version: "v1", auth });
  const maxReads = Math.min(
    mailboxBatchSize,
    Math.max(1, Math.floor(window.maxReads ?? mailboxBatchSize)),
  );
  const historyMode = (window.mode ?? window.run?.mode) === "history";
  let ids: string[] = [],
    removedIds: string[] = [],
    nextPageToken = window.pageToken,
    historyId = window.historyId,
    baselineHistoryId = window.baselineHistoryId;
  if (!(await permitted())) throw new Error("Mailbox reading stopped.");
  if (window.accountEmail) {
    stage("account");
    const profile = (
      await api.users.getProfile(
        { userId: "me", fields: "emailAddress,historyId" },
        opts,
      )
    ).data;
    if (
      !profile.emailAddress ||
      profile.emailAddress.toLowerCase() !== window.accountEmail.toLowerCase()
    )
      throw new Error(
        "The Gmail token account does not match the permitted mailbox.",
      );
    if (!historyMode && window.request.kind === "check" && !baselineHistoryId) {
      if (!historyIdValid(profile.historyId))
        throw new Error("Gmail returned an invalid starting checkpoint.");
      baselineHistoryId = profile.historyId;
    }
  }
  if (window.pendingProviderIds?.length) {
    ids = window.pendingProviderIds;
    if (historyMode && window.run?.resultHistoryId)
      baselineHistoryId = window.run.resultHistoryId;
  } else if (historyMode && historyId) {
    stage("history");
    if (!historyIdValid(historyId)) throw new MailboxResync(true);
    let page: gmail_v1.Schema$ListHistoryResponse;
    try {
      page = (
        await api.users.history.list(
          {
            userId: "me",
            startHistoryId: historyId,
            maxResults: mailboxBatchSize,
            fields:
              "historyId,nextPageToken,history(id,messages(id),messagesAdded(message(id)),messagesDeleted(message(id)),labelsAdded(message(id),labelIds),labelsRemoved(message(id),labelIds))",
            ...(window.pageToken ? { pageToken: window.pageToken } : {}),
          },
          opts,
        )
      ).data;
    } catch (e) {
      if (providerCode(e) === 404) throw new MailboxResync(true);
      if (window.pageToken && cursorFailure(e)) throw new MailboxResync();
      throw e;
    }
    if (!historyIdValid(page.historyId))
      throw new Error("Gmail returned an invalid history checkpoint.");
    if (window.pageToken && page.nextPageToken === window.pageToken)
      throw new MailboxResync();
    if ((page.history?.length ?? 0) > mailboxBatchSize)
      throw new Error("Gmail exceeded its requested history page.");
    const changed = new Set<string>(),
      deleted = new Set<string>();
    const add = (id: unknown, set: Set<string>) => {
      if (!opaqueId(id))
        throw new Error("Gmail returned an invalid history message.");
      set.add(id);
      if (set.size > 200) throw new MailboxResync(true);
    };
    for (const h of page.history ?? []) {
      for (const item of h.messages ?? []) add(item.id, changed);
      for (const item of h.messagesAdded ?? []) add(item.message?.id, changed);
      for (const item of h.messagesDeleted ?? [])
        add(item.message?.id, deleted);
      for (const item of [...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])])
        add(item.message?.id, changed);
    }
    ids = [...changed].filter((id) => !deleted.has(id));
    removedIds = [...deleted];
    nextPageToken = page.nextPageToken ?? undefined;
    // Preserve the starting checkpoint until the last history page is durably processed.
    baselineHistoryId = page.historyId;
  } else {
    if (window.request.kind === "check" && !baselineHistoryId) {
      stage("account");
      if (!(await permitted())) throw new Error("Mailbox reading stopped.");
      const profile = (
        await api.users.getProfile({ userId: "me", fields: "historyId" }, opts)
      ).data;
      if (!historyIdValid(profile.historyId))
        throw new Error("Gmail returned an invalid starting checkpoint.");
      baselineHistoryId = profile.historyId;
    }
    let page: gmail_v1.Schema$ListMessagesResponse;
    stage("listing");
    try {
      page = (
        await api.users.messages.list(
          {
            userId: "me",
            q: mailboxQuery(window.request, window.from, window.through),
            maxResults: mailboxBatchSize,
            includeSpamTrash: false,
            ...(window.pageToken ? { pageToken: window.pageToken } : {}),
          },
          opts,
        )
      ).data;
    } catch (e) {
      if (window.pageToken && cursorFailure(e)) throw new MailboxResync();
      throw e;
    }
    if ((page.messages?.length ?? 0) > mailboxBatchSize)
      throw new Error("Gmail exceeded its requested message page.");
    if (window.pageToken && page.nextPageToken === window.pageToken)
      throw new MailboxResync();
    for (const item of page.messages ?? []) {
      if (!opaqueId(item.id))
        throw new Error("Gmail returned an invalid message identifier.");
      ids.push(item.id);
    }
    nextPageToken = page.nextPageToken ?? undefined;
  }
  if (nextPageToken && !opaqueId(nextPageToken))
    throw new Error("Gmail returned an invalid page cursor.");
  if (ids.length > 200 || ids.some((id) => !opaqueId(id)))
    throw new MailboxResync(true);
  const messages: ReadMail[] = [];
  for (const id of ids.slice(0, maxReads)) {
    stage("message");
    if (!(await permitted())) throw new Error("Mailbox reading stopped.");
    let m: gmail_v1.Schema$Message;
    try {
      m = (
        await api.users.messages.get(
          {
            userId: "me",
            id,
            format: "full",
            fields: "id,threadId,internalDate,labelIds,snippet,payload",
          },
          opts,
        )
      ).data;
    } catch (e) {
      if (providerCode(e) === 404) {
        removedIds.push(id);
        continue;
      }
      throw e;
    }
    if (m.id !== id)
      throw new Error("Gmail returned a different message than requested.");
    const labels = m.labelIds ?? [];
    if (
      labels.some((l) => ["SPAM", "TRASH", "DRAFT"].includes(l)) ||
      (window.request.kind === "check" && !labels.includes("INBOX"))
    ) {
      removedIds.push(id);
      continue;
    }
    const receivedAt = Number(m.internalDate);
    if (
      !/^\d+$/.test(m.internalDate ?? "") ||
      !Number.isSafeInteger(receivedAt)
    )
      throw new Error("Gmail returned an invalid received date.");
    if (
      !historyMode &&
      (receivedAt < window.from || receivedAt > window.through)
    )
      continue;
    const headers = m.payload?.headers ?? [],
      from = headers.filter((h) => h.name?.toLowerCase() === "from");
    const sender = from.length === 1 ? exactSender(from[0].value ?? "") : null;
    const { text, ...extraction } = extractGmailMessage(m);
    if (!sender) {
      extraction.incomplete = true;
      extraction.issues = [
        ...extraction.issues.slice(0, 7),
        "The sender address could not be verified.",
      ];
    }
    const replyRouting = gmailReplyRouting(m);
    messages.push({
      providerId: id,
      ...(replyRouting ? { replyRouting } : {}),
      ...(opaqueId(m.threadId) ? { threadId: m.threadId } : {}),
      sender: sender ?? "(Sender unavailable)",
      subject: (decodeGmailSubject(headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? '') || headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "(No subject)").slice(0, 300),
      receivedAt,
      text,
      extraction,
      labels,
    });
  }
  return {
    messages,
    removedIds: [...new Set(removedIds)],
    processed: ids.slice(0, maxReads).length,
    pendingProviderIds: ids.slice(maxReads),
    ...(nextPageToken ? { nextPageToken } : {}),
    ...(baselineHistoryId ? { baselineHistoryId } : {}),
    ...(historyMode && baselineHistoryId
      ? { historyId: baselineHistoryId }
      : {}),
  };
}
export const check = internalAction({
  args: { id: v.id("mailRuns"), version: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const lease = { ...args, lease: randomBytes(20).toString("hex") };
    const current = await ctx.runMutation(internal.mailbox.claim, lease);
    if (!current) return;
    let stage: MailboxFailure["stage"] = "authorization";
    try {
      await withGoogle(
        ctx,
        {
          connectionId: current.connectionId,
          connectionVersion: current.connectionVersion,
        } as Doc<"approvals">,
        async (auth) => {
          const result = await readMailboxBatch(
            auth,
            current,
            () => ctx.runQuery(internal.mailbox.permitted, lease),
            (value) => {
              stage = value;
            },
          );
          stage = "persistence";
          await ctx.runMutation(internal.mailbox.finishBatch, {
            ...lease,
            ...result,
          });
        },
      );
    } catch (e) {
      if (e instanceof MailboxResync)
        await ctx.runMutation(internal.mailbox.resetCursor, {
          ...lease,
          resetHistory: e.history,
        });
      else {
        const failure =
          e instanceof ConnectionBusy
            ? { stage, code: "connection_busy" as const }
            : e instanceof ReviewRequired
              ? { stage, code: "access_changed" as const }
              : mailboxFailure(e, stage);
        await ctx.runMutation(internal.mailbox.failed, {
          ...lease,
          reconnect: failure.code === "permission",
          failure,
        });
      }
    }
  },
});
export const summarize = internalAction({
  args: { id: v.id("mailRuns"), version: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const context = await ctx.runQuery(internal.mailbox.summaryContext, args);
    if (!context) return;
    const { run, messages } = context;
    if (run.agentRequested) return; // The coordinating assistant summarizes these sources once.
    const sources = messages.map((m) => ({
      id: m._id,
      version: m.version,
      hash: m.contentHash,
    }));
    if (!messages.length) {
      await ctx.runMutation(internal.mailbox.finishSummary, {
        ...args,
        sources,
        answer:
          "No readable saved messages are available in this checked window.",
        evidence: [],
      });
      return;
    }
    if (!process.env.ANTHROPIC_API_KEY || !process.env.DAYMARK_MODEL) {
      await ctx.runMutation(internal.mailbox.finishSummary, {
        ...args,
        sources,
        answer:
          "AI summaries are not configured; review the source messages below.",
        evidence: [],
        issue: "model_unconfigured",
      });
      return;
    }
    await ctx.runMutation(internal.mailFollowthrough.start, {
      runId: run._id,
      runVersion: run.version,
      sources,
    });
  },
});
