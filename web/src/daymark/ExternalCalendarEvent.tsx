import { useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { ExternalCalendarPreview } from "../../../convex/calendarReading";
import {
  calendarSchema,
  calendarTimes,
  type CalendarDraft,
} from "../../../shared/daymark";
import type { DaymarkClient } from './types';
import type { CoordinatorCalendarOrigin } from '../../../shared/assistantCoordinator';
import { connectorErrorMessage } from "../../../shared/connectorErrors";
/** Only an explicit parent selection opens this review; private feed events never become shared targets automatically. */
type Props = { eventId: string; origin?: CoordinatorCalendarOrigin; onClose(): void; onPrepared?(jobId: string): void }
type CalendarClient = Required<Pick<DaymarkClient, 'inspectCalendarEvent' | 'prepareCalendarEventChange'>>
export function ExternalCalendarEvent(props: Props & { client?: DaymarkClient }) {
  return props.client?.inspectCalendarEvent && props.client.prepareCalendarEventChange
    ? <CalendarEventReview {...props} inspect={props.client.inspectCalendarEvent} prepare={props.client.prepareCalendarEventChange} />
    : <ConnectedCalendarEvent {...props} />
}
function ConnectedCalendarEvent(props: Props) {
  const inspect = useAction(api.calendarReading.inspectEvent), prepare = useAction(api.calendarReading.prepareEventChange)
  const origin = (value?: CoordinatorCalendarOrigin) => value ? { ...value, id: value.id as Id<'assistantRuns'> } : undefined
  return <CalendarEventReview {...props}
    inspect={(eventId, context) => inspect({ eventId: eventId as Id<'calendarFeedEvents'>, ...(context ? { origin: origin(context) } : {}) })}
    prepare={(preview, proposed) => prepare({ eventId: preview.eventId, feedVersion: preview.feedVersion, connectionVersion: preview.connectionVersion, selectionVersion: preview.selectionVersion, etag: preview.etag, originalHash: preview.originalHash, proposed, consent: true, ...(preview.origin ? { origin: origin(preview.origin) } : {}) })} />
}
function CalendarEventReview({ eventId, origin, onClose, onPrepared, inspect, prepare }: Props & { inspect: CalendarClient['inspectCalendarEvent']; prepare: CalendarClient['prepareCalendarEventChange'] }) {
  const dialog = useRef<HTMLDialogElement>(null), pending = useRef(false);
  const inspectCurrent = useRef(inspect)
  inspectCurrent.current = inspect
  const [preview, setPreview] = useState<ExternalCalendarPreview | null>(null),
    [draft, setDraft] = useState<CalendarDraft | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [consent, setConsent] = useState(false);
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError("");
    setPreview(null);
    setDraft(null);
    setConsent(false);
    inspectCurrent.current(eventId, origin)
      .then((result) => {
        if (active) {
          setPreview(result);
          setDraft(result.original);
        }
      })
      .catch((e) => {
        if (active) setError(connectorErrorMessage(e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [eventId, origin?.id, origin?.version, origin?.index]);
  const field = (key: keyof CalendarDraft, value: string | boolean | null) => {
    setDraft((old) => (old ? { ...old, [key]: value } : old));
    setConsent(false);
  };
  let valid = false;
  if (draft)
    try {
      calendarSchema.strict().parse(draft);
      calendarTimes(draft);
      valid = true;
    } catch {
      /* The parent keeps incomplete edits until dates are corrected. */
    }
  const save = async () => {
    if (pending.current || !preview || !draft || !consent) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const jobId = await prepare(preview, draft);
      onPrepared?.(jobId);
      onClose();
    } catch (e) {
      setError(connectorErrorMessage(e));
      setConsent(false);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="dm-sheet dm-mail-sheet"
      aria-label="Review connected calendar event"
      onCancel={(e) => {
        e.preventDefault();
        if (!pending.current) onClose();
      }}
    >
      <header>
        <h2>Calendar event</h2>
        <button disabled={pending.current} onClick={onClose}>
          Done
        </button>
      </header>
      <p className="dm-mail-private">
        Private until you choose to share this review. Nothing has been changed
        in your calendar.
      </p>
      {busy && !preview && (
        <p role="status">Reading current calendar details…</p>
      )}
      {preview && draft && (
        <>
          <details>
            <summary>Current event</summary>
            <p>{preview.original.title}</p>
            <p>
              {preview.original.date}
              {preview.original.startTime
                ? ` at ${preview.original.startTime}`
                : ""}{" "}
              to {preview.original.endDate}
              {preview.original.endTime
                ? ` at ${preview.original.endTime}`
                : ""}{" "}
              · {preview.original.timezone}
            </p>
            {preview.original.location && <p>{preview.original.location}</p>}
            {preview.original.notes && (
              <p style={{ whiteSpace: "pre-wrap" }}>{preview.original.notes}</p>
            )}
          </details>
          <fieldset disabled={busy}>
            <legend>Proposed change</legend>
            <label>
              Action
              <select
                value={draft.operation || "save"}
                onChange={(e) => field("operation", e.target.value)}
              >
                <option value="save">Update this event</option>
                <option value="delete">Remove this event</option>
              </select>
            </label>
            <fieldset disabled={draft.operation === "delete"}>
              <label>
                Title
                <input
                  maxLength={300}
                  value={draft.title}
                  onChange={(e) => field("title", e.target.value)}
                />
              </label>
              <label className="dm-check">
                <input
                  type="checkbox"
                  checked={draft.allDay}
                  onChange={(e) => {
                    const allDay = e.target.checked;
                    setDraft((old) =>
                      old
                        ? {
                            ...old,
                            allDay,
                            startTime: allDay ? null : "",
                            endTime: allDay ? null : "",
                          }
                        : old,
                    );
                    setConsent(false);
                  }}
                />
                All day
              </label>
              <label>
                Start date
                <input
                  type="date"
                  value={draft.date}
                  onChange={(e) => field("date", e.target.value)}
                />
              </label>
              {!draft.allDay && (
                <label>
                  Start time
                  <input
                    type="time"
                    value={draft.startTime || ""}
                    onChange={(e) => field("startTime", e.target.value)}
                  />
                </label>
              )}
              <label>
                End date
                <input
                  type="date"
                  value={draft.endDate}
                  onChange={(e) => field("endDate", e.target.value)}
                />
              </label>
              {!draft.allDay && (
                <label>
                  End time
                  <input
                    type="time"
                    value={draft.endTime || ""}
                    onChange={(e) => field("endTime", e.target.value)}
                  />
                </label>
              )}
              <label>
                Timezone
                <input
                  maxLength={100}
                  value={draft.timezone}
                  onChange={(e) => field("timezone", e.target.value)}
                />
              </label>
              <label>
                Location
                <input
                  maxLength={300}
                  value={draft.location}
                  onChange={(e) => field("location", e.target.value)}
                />
              </label>
              <label>
                Notes
                <textarea
                  rows={4}
                  maxLength={2000}
                  value={draft.notes}
                  onChange={(e) => field("notes", e.target.value)}
                />
              </label>
            </fieldset>
            <label className="dm-check">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              Share the original and edited event details shown here with my
              household and prepare this exact calendar change for separate
              approval.
            </label>
            <p className="dm-muted">
              This creates a review draft. It does not approve a calendar write.
              Changes to the event or account require a fresh review. Meetings,
              repeating events and unsupported settings stay in the provider’s
              calendar.
            </p>
            <button
              className="dm-primary"
              disabled={!consent || !valid}
              onClick={() => void save()}
            >
              {busy ? "Preparing…" : "Prepare calendar change for approval"}
            </button>
          </fieldset>
        </>
      )}
      {error && (
        <p role="alert" className="dm-error">
          {error}
        </p>
      )}
    </dialog>
  );
}
