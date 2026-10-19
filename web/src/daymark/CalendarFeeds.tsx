import { useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  calendarReadAllowed,
  calendarSelectionSchema,
  type CalendarSelection,
} from "../../../shared/calendarAwareness";
import { connectorErrorMessage } from "../../../shared/connectorErrors";
export type CalendarReadConnection = {
  id: string;
  version: number;
  provider: "google" | "microsoft" | "apple";
  status: string;
  scopes: string[];
  email?: string;
  calendarId?: string;
  calendarName?: string;
};
/** Connected-only settings. Reading/processing consent never grants calendar write approval. */
export function CalendarFeeds({
  connections,
  onConnect,
  onConnectEditing,
  selectionVersion,
}: {
  connections: CalendarReadConnection[];
  onConnect(provider: "google" | "microsoft"): Promise<void>;
  onConnectEditing?(provider: "google" | "microsoft"): Promise<void>;
  selectionVersion?: number;
}) {
  const setAssistance = useMutation(api.calendarAssistance.setEnabled);
  const selectGoogle = useAction(api.google.selectCalendar),
    selectMicrosoft = useAction(api.calendarReading.selectMicrosoftCalendar);
  const feeds = useQuery(api.calendarFeeds.settings, {}),
    discover = useAction(api.calendarReading.calendars),
    save = useMutation(api.calendarFeeds.save),
    change = useMutation(api.calendarFeeds.change),
    sync = useMutation(api.calendarFeeds.sync);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [choice, setChoice] = useState<CalendarReadConnection | null>(null),
    [available, setAvailable] = useState<
      Array<CalendarSelection & { writable: boolean }>
    >([]),
    [selected, setSelected] = useState<string[]>([]),
    [consent, setConsent] = useState(false),
    [hasMore, setHasMore] = useState(false);
  const run = async (work: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(connectorErrorMessage(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const configure = (connection: CalendarReadConnection) =>
    void run(async () => {
      const result = await discover({
        connectionId: connection.id as Id<"connections">,
        connectionVersion: connection.version,
      });
      setAvailable(result.items);
      setHasMore(result.hasMore);
      setChoice(connection);
      setConsent(false);
      const previous = feeds?.find((f) => f.connectionId === connection.id);
      setSelected(
        previous?.calendars
          .filter((c) => result.items.some((r) => r.id === c.id))
          .map((c) => c.id) ?? [],
      );
    });
  return (
    <section aria-label="Connected calendar reading">
      <p className="dm-muted">
        Let Sola read selected calendars to understand commitments and spot
        overlaps. These events stay private to you. Adding or changing an event
        still needs separate approval.
      </p>
      {(["google", "microsoft"] as const).map((provider) => {
        const connection = connections.find(
            (c) => c.provider === provider && c.status !== "revoked",
          ),
          feed =
            connection && feeds?.find((f) => f.connectionId === connection.id);
        const name =
          provider === "google" ? "Google Calendar" : "Microsoft Calendar";
        return (
          <div key={provider} className="dm-memory-row">
            <strong>{name}</strong>
            {connection?.email && (
              <p className="dm-muted">{connection.email}</p>
            )}
            {!connection || !calendarReadAllowed(connection) ? (
              <button
                disabled={busy}
                onClick={() => void run(() => onConnect(provider))}
              >
                Connect calendar reading
              </button>
            ) : (
              <>
                {feed && (
                  <>
                    <p className="dm-muted">
                      {feed.state === "paused"
                        ? "Reading paused"
                        : feed.needsReconnect
                          ? "Access changed · confirm calendars again"
                          : feed.syncing
                            ? "Checking selected calendars…"
                            : feed.lastCheckedAt
                              ? `Checked ${new Date(feed.lastCheckedAt).toLocaleString()}`
                              : "Not checked yet"}
                    </p>
                    {feed.coverage && (
                      <p className="dm-muted">
                        {feed.coverage.count} events ·{" "}
                        {new Date(feed.coverage.from).toLocaleDateString()}–
                        {new Date(feed.coverage.through).toLocaleDateString()}
                        {feed.coverage.partial ? " · Partial coverage" : ""}
                      </p>
                    )}
                    {feed.issue && <p role="status">{feed.issue}</p>}
                    <details>
                      <summary>More</summary>
                      <label className="dm-check">
                        <input
                          type="checkbox"
                          checked={feed.assistanceEnabled}
                          disabled={
                            busy ||
                            (!feed.assistanceEnabled &&
                              (feed.state !== "active" ||
                                feed.needsReconnect ||
                                !feed.assistanceConfigured))
                          }
                          onChange={(e) => {
                            const enabled = e.target.checked;
                            void run(() =>
                              setAssistance({
                                feedId: feed.id,
                                feedVersion: feed.version,
                                assistanceVersion: feed.assistanceVersion,
                                enabled,
                                ...(enabled ? { consent: true as const } : {}),
                              }),
                            );
                          }}
                        />
                        Prepare useful follow-ups for calendar changes
                      </label>
                      <p className="dm-muted">
                        Privately consider changes to event times, titles and
                        locations, and removed events. Nothing is shared, sent
                        or changed automatically. Limited to fresh, complete
                        calendar windows; unchanged checks stay quiet.
                      </p>
                      {!feed.assistanceConfigured && (
                        <p>Assistant model setup is needed first.</p>
                      )}
                      {feed.assistanceIssue && (
                        <p role="status">{feed.assistanceIssue}</p>
                      )}
                    </details>
                    <div className="dm-actions">
                      <button
                        disabled={
                          busy ||
                          feed.needsReconnect ||
                          feed.syncing ||
                          feed.state !== "active"
                        }
                        onClick={() =>
                          void run(() =>
                            sync({ id: feed.id, version: feed.version }),
                          )
                        }
                      >
                        Check now
                      </button>
                      {feed.state === "active" && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              change({
                                id: feed.id,
                                version: feed.version,
                                operation: "pause",
                              }),
                            )
                          }
                        >
                          Pause reading
                        </button>
                      )}
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            change({
                              id: feed.id,
                              version: feed.version,
                              operation: "remove",
                            }),
                          )
                        }
                      >
                        Remove saved calendar access
                      </button>
                    </div>
                  </>
                )}
                <button disabled={busy} onClick={() => configure(connection)}>
                  {feed
                    ? feed.state === "paused"
                      ? "Choose calendars & resume"
                      : "Choose calendars"
                    : "Choose calendars to read"}
                </button>
              </>
            )}
          </div>
        );
      })}
      {choice && (
        <fieldset disabled={busy}>
          <legend>Calendars for {choice.email || choice.provider}</legend>
          <p className="dm-muted">
            Choose up to five. Reading covers the previous week and next 90
            days, refreshed about every 15 minutes. A partial or old check
            cannot establish availability.
          </p>
          {hasMore && (
            <p role="status">
              Only the first 100 calendars are listed. Additional calendars are
              not included.
            </p>
          )}
          {available.length === 0 && (
            <p>No readable calendars were returned.</p>
          )}
          {choice &&
            !(choice.provider === "google"
              ? choice.scopes.includes(
                  "https://www.googleapis.com/auth/calendar.events",
                )
              : choice.scopes.some(
                  (scope) => scope.toLowerCase() === "calendars.readwrite",
                )) &&
            onConnectEditing && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    onConnectEditing(choice.provider as "google" | "microsoft"),
                  )
                }
              >
                Enable reviewed calendar changes
              </button>
            )}
          {available.map((calendar) => (
            <div key={calendar.id}>
              <label className="dm-check">
                <input
                  type="checkbox"
                  checked={selected.includes(calendar.id)}
                  onChange={(e) => {
                    setSelected((old) =>
                      e.target.checked
                        ? [...old, calendar.id]
                        : old.filter((id) => id !== calendar.id),
                    );
                    setConsent(false);
                  }}
                  disabled={
                    !selected.includes(calendar.id) && selected.length >= 5
                  }
                />
                {calendar.name}
              </label>
              {calendar.writable &&
                selectionVersion !== undefined &&
                (choice.provider === "google"
                  ? choice.scopes.includes(
                      "https://www.googleapis.com/auth/calendar.events",
                    )
                  : choice.scopes.some(
                      (scope) => scope.toLowerCase() === "calendars.readwrite",
                    )) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const select =
                          choice.provider === "google"
                            ? selectGoogle
                            : selectMicrosoft;
                        await select({
                          connectionId: choice.id as Id<"connections">,
                          connectionVersion: choice.version,
                          selectionVersion,
                          calendarId: calendar.id,
                        });
                        setChoice(null);
                        setConsent(false);
                      })
                    }
                  >
                    Use {calendar.name} for approved changes
                  </button>
                )}
              {selected.includes(calendar.id) && (
                <label>
                  Display timezone
                  <input
                    value={calendar.timezone}
                    maxLength={100}
                    onChange={(e) => {
                      const value = e.target.value;
                      setAvailable((old) =>
                        old.map((c) =>
                          c.id === calendar.id ? { ...c, timezone: value } : c,
                        ),
                      );
                      setConsent(false);
                    }}
                  />
                </label>
              )}
            </div>
          ))}
          <label className="dm-check">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            Allow Sola to privately read these calendars and use their event
            details to help me plan. Other household members cannot see them.
            This does not approve calendar changes.
          </label>
          <div className="dm-actions">
            <button
              className="dm-primary"
              disabled={
                !consent ||
                !calendarSelectionSchema.safeParse(
                  available
                    .filter((c) => selected.includes(c.id))
                    .map(({ id, name, timezone }) => ({ id, name, timezone })),
                ).success
              }
              onClick={() =>
                void run(async () => {
                  const feed = feeds?.find((f) => f.connectionId === choice.id);
                  await save({
                    connectionId: choice.id as Id<"connections">,
                    connectionVersion: choice.version,
                    calendars: available
                      .filter((c) => selected.includes(c.id))
                      .map(({ id, name, timezone }) => ({
                        id,
                        name,
                        timezone,
                      })),
                    consent,
                    ...(feed ? { version: feed.version } : {}),
                  });
                  setChoice(null);
                  setConsent(false);
                })
              }
            >
              {busy ? "Saving…" : "Save private calendar reading"}
            </button>
            <button
              onClick={() => {
                setChoice(null);
                setConsent(false);
              }}
            >
              Cancel
            </button>
          </div>
        </fieldset>
      )}
      {error && (
        <p role="alert" className="dm-error">
          {error}
        </p>
      )}
    </section>
  );
}
