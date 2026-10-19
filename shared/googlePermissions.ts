export const gmailSendScope = "https://www.googleapis.com/auth/gmail.send";
export const gmailComposeScope =
  "https://www.googleapis.com/auth/gmail.compose";

/** Both supported grants permit sending. Reading, unrelated and broader grants do not select a Sola send tool. */
export function canSendGmail(scopes: readonly string[]) {
  return scopes.includes(gmailSendScope) || scopes.includes(gmailComposeScope);
}

export const googleCalendarEventsScope =
  "https://www.googleapis.com/auth/calendar.events";
export const googleCreatedCalendarScope =
  "https://www.googleapis.com/auth/calendar.app.created";
/** Reading permission alone never selects a calendar commit tool. */
export function canWriteGoogleCalendar(scopes: readonly string[]) {
  return (
    scopes.includes(googleCalendarEventsScope) ||
    scopes.includes(googleCreatedCalendarScope)
  );
}
