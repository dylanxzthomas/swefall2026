import type { DaymarkClient, DaymarkState } from './types'
export function selectedAccount(state: DaymarkState, purpose: 'calendar' | 'email') {
  if (state.accounts) return state.accounts.items.find(c => c.id === (purpose === 'calendar' ? state.accounts!.calendarId : state.accounts!.emailId)) ?? null
  const c = state.connection
  if (!c) return null
  return { ...c, id: '', version: 0, provider: 'google' as const, calendarName: 'Daymark', calendar: c.status === 'active' && !!c.calendarId && c.scopes.includes('https://www.googleapis.com/auth/calendar.app.created'), mail: c.status === 'active' && c.scopes.includes('https://www.googleapis.com/auth/gmail.send') }
}
export default function ConnectionSettings({ state, client, busy, run }: { state: DaymarkState; client: DaymarkClient; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const accounts = state.accounts
  return <>
    {state.nativeCalendar?.available && <details><summary>Apple Calendar</summary><p>Use a writable calendar already on this iPhone, including iCloud calendars. Reading it back requires full calendar access.</p><button disabled={busy} onClick={() => void run(() => client.connectNativeCalendar!())}>{state.nativeCalendar.permission === 'granted' ? 'Refresh iPhone calendars' : 'Connect Apple Calendar'}</button>{state.nativeCalendar.permission === 'denied' && <p>Allow full Calendar access for Daymark in iPhone Settings, then try again.</p>}{state.nativeCalendar.permission === 'granted' && <label>Calendar on this iPhone<select value={state.nativeCalendar.selectedId ?? ''} disabled={busy} onChange={e => void run(() => client.selectNativeCalendar!(e.target.value || null))}><option value="">{state.storage === 'device' ? 'Device plan only' : 'Disconnect this iPhone calendar'}</option>{state.nativeCalendar.calendars.map(c => <option key={c.id} value={c.id}>{c.title} · {c.account}</option>)}</select></label>}<p className="dm-muted">Receipts confirm the calendar on this phone. iCloud sync is separate.</p></details>}
    {state.storage !== 'device' && <details><summary>Calendar & email accounts</summary><p>Choose your calendar and sending account independently.</p>{accounts && (['calendar', 'email'] as const).map(purpose => <label key={purpose}>{purpose === 'calendar' ? 'Calendar destination' : 'Send school email from'}<select disabled={busy} value={(purpose === 'calendar' ? accounts.calendarId : accounts.emailId) ?? ''} onChange={e => void run(() => client.chooseAccount!(purpose, e.target.value, accounts.version))}><option value="" disabled>Connect an account</option>{accounts.items.filter(c => purpose === 'calendar' ? c.calendar : c.mail).map(c => <option key={c.id} value={c.id}>{c.provider === 'apple' ? 'Apple Calendar' : c.provider === 'microsoft' ? 'Outlook' : 'Google'} · {c.email}{purpose === 'calendar' ? ` · ${c.calendarName ?? 'Daymark'}` : ''}</option>)}</select></label>)}
      {(['google', 'microsoft'] as const).map(provider => {
        const c = accounts?.items.find(c => c.provider === provider), configured = accounts ? accounts.configured[provider] : provider === 'google'
        return <section key={provider} className="dm-setting-item">
          <p>{provider === 'google' ? 'Google' : 'Microsoft Outlook'}{c?.email ? ` · ${c.email}` : ''}</p>
          {!configured && <p className="dm-muted">Connection setup is still needed.</p>}
          {c?.status === 'revocation_unconfirmed' && <p>Disconnected in Daymark. Remove Daymark in {provider === 'google' ? 'Google' : 'Microsoft'} account permissions to revoke the provider grant.</p>}
          {(configured || c) && <div className="dm-actions">
            {configured && <><button disabled={busy} onClick={() => void run(() => client.connect('calendar', provider))}>{provider === 'google' ? 'Connect & create Daymark calendar' : 'Connect Outlook calendar'}</button>{provider === 'microsoft' && <button disabled={busy} onClick={() => void run(() => client.connect('gmail', provider))}>Connect Outlook email</button>}</>}
            {c && <button disabled={busy} onClick={() => void run(() => client.disconnect(c.id))}>Disconnect {provider === 'google' ? 'Google' : 'Microsoft'}</button>}
          </div>}
        </section>
      })}
      <p className="dm-muted">Google uses a separate Daymark calendar. Outlook uses your account’s default calendar. Every change needs your approval.</p>
    </details>}
  </>
}
