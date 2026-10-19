import { waitForVoiceRequest } from './voiceBrowser'
import { useCalendarWindow } from './useCalendarWindow'
import { validateLibraryFiles } from '../../../shared/library'
import { authenticationNotice, browserAuthOptions, connectionReturn, nativeSignInReturnMessage, pickupSecret, signInReturnPath } from '../../../shared/authentication'
import { useAppleCalendar } from './useAppleCalendar'
import { useEffect, useRef, useState } from 'react'
import { Auth0Provider, useAuth0 } from '@auth0/auth0-react'
import { ConvexReactClient, ConvexProvider, useAction, useMutation, useQuery, useConvexAuth } from 'convex/react'
import { ConvexProviderWithAuth0 } from 'convex/react-auth0'
import { Preferences } from '@capacitor/preferences'
import { PushNotifications } from '@capacitor/push-notifications'
import { registerPhone, unregisterPhone } from './push'
import { Browser } from '@capacitor/browser'
import { App as NativeApp } from '@capacitor/app'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import Daymark from './Daymark'
import DeviceApplication from './DeviceApplication'
import { caregiverSignInOptions } from './caregiverSignIn'
import CaregiverPage from './CaregiverPage'
import { saveFiles } from './outbox'
import { native, nativeCache, nativeCallback, signInTransaction } from './session'
import { NativeAuthClient } from './nativeAuthClient'
import type { DaymarkState, DaymarkClient } from './types'
import type { Routine, RoutineRun } from '../../../shared/routines'
const config = { url: import.meta.env.VITE_CONVEX_URL, domain: import.meta.env.VITE_AUTH0_DOMAIN, clientId: native ? import.meta.env.VITE_AUTH0_NATIVE_CLIENT_ID : import.meta.env.VITE_AUTH0_CLIENT_ID }
const convex = config.url ? new ConvexReactClient(config.url) : null
function Connected() {
  const auth = useAuth0(), session = useConvexAuth()
  const household = useQuery(api.households.current, session.isAuthenticated ? {} : 'skip')
  const ready = session.isAuthenticated && household && !household.deleted ? {} : 'skip'
  const pickupDelivery = useQuery(api.pickups.deliverySettings, ready), incomingPickups = useQuery(api.pickups.inbox, ready)
  const savePickupDelivery = useMutation(api.pickups.saveDeliverySettings), respondToPickup = useMutation(api.pickups.respondInApp)
  const jobs = useQuery(api.jobs.list, ready), plan = useQuery(api.jobs.plan, ready), caregivers = useQuery(api.pickups.list, ready), arrangements = useQuery(api.pickups.arrangements, ready), connection = useQuery(api.connections.current, ready)
  const accounts = useQuery(api.connections.overview, ready), chooseAccount = useMutation(api.connections.choose), connectMicrosoft = useAction(api.microsoft.connect)
  const apple = useAppleCalendar(ready !== 'skip', accounts)
  const usesApple = (id: string) => { const a = jobs?.flatMap(j => j.actions).find(a => a._id === id); return a?.provider === 'apple' || a?.before?.provider === 'apple' || a?.payload.kind === 'calendar' && accounts?.items.find(c => c.id === accounts.calendarId)?.provider === 'apple' }
  const notificationSettings = useQuery(api.notifications.settings, ready), saveNotifications = useMutation(api.notifications.save), presence = useMutation(api.notifications.presence), unregister = useMutation(api.notifications.unregister)
  const [nativeError, setNativeError] = useState(''), handledUrl = useRef('')
  const forwarding = useQuery(api.inbound.current, ready), enableForwarding = useMutation(api.inbound.enable), retryForwarded = useMutation(api.inbound.retry)
  const facts = useQuery(api.memory.list, ready), saveFact = useMutation(api.memory.save), removeFact = useMutation(api.memory.remove), updateCaregiver = useMutation(api.pickups.updateCaregiver)
  const library = useQuery(api.library.list, ready), preferences = useQuery(api.library.preferences, ready), saveLibraryArtifact = useMutation(api.library.saveArtifact), updateLibrary = useMutation(api.library.update), removeLibrary = useMutation(api.library.remove), savePreferences = useMutation(api.library.savePreferences), storeLibraryFiles = useAction(api.library.saveFiles)
  const personalTasks = useQuery(api.personalTasks.list, ready), createPersonalTask = useMutation(api.personalTasks.create), updatePersonalTask = useMutation(api.personalTasks.update), setPersonalTaskDone = useMutation(api.personalTasks.setDone), removePersonalTask = useMutation(api.personalTasks.remove), scheduleRequest = useMutation(api.jobs.schedule), saveHouseholdName = useMutation(api.households.saveName)
  const routines = useQuery(api.routines.list, ready), routineSettings = useQuery(api.routines.settings, ready)
  const createRoutine = useMutation(api.routines.create), updateRoutine = useMutation(api.routines.update), setRoutinePaused = useMutation(api.routines.setPaused), removeRoutine = useMutation(api.routines.remove)
  const mailRoutines = useQuery(api.mailRoutines.list, ready), createMailRoutine = useMutation(api.mailRoutines.create), updateMailRoutine = useMutation(api.mailRoutines.update), setMailRoutinePaused = useMutation(api.mailRoutines.setPaused), removeMailRoutine = useMutation(api.mailRoutines.remove)
  const voiceSettings=useQuery(api.voice.settings,ready),startVoice=useAction(api.realtimeVoice.start),stopVoice=useMutation(api.voice.stop),requestVoice=useMutation(api.voice.request)
  const assistantRuns = useQuery(api.assistantCoordinator.list,ready), retryAssistant=useMutation(api.assistantCoordinator.retry), reviewAssistantDraft=useMutation(api.assistantCoordinator.review)
  const privateTasks = useQuery(api.privateTasks.list, ready), updatePrivateTask = useMutation(api.privateTasks.update), setPrivateTaskDone = useMutation(api.privateTasks.setDone), removePrivateTask = useMutation(api.privateTasks.remove)
  const learnedWorkflows=useQuery(api.learnedWorkflows.list,ready),suggestWorkflow=useMutation(api.learnedWorkflows.request),editLearnedWorkflow=useMutation(api.learnedWorkflows.update),approveLearnedWorkflow=useMutation(api.learnedWorkflows.approve),dismissLearnedWorkflow=useMutation(api.learnedWorkflows.dismiss)
  const mailAttachments=useQuery(api.mailAttachments.list,ready),discoverMailAttachments=useAction(api.gmailAttachments.discover),readMailAttachment=useMutation(api.mailAttachments.read)
  const calendarWindow = useCalendarWindow(household?.timezone ?? 'UTC')
  const calendarAgenda=useQuery(api.calendarFeeds.agenda,ready==='skip'?'skip':calendarWindow)
  const inspectCalendarEvent=useAction(api.calendarReading.inspectEvent), prepareCalendarEventChange=useAction(api.calendarReading.prepareEventChange)
  const workingMemory = useQuery(api.workingMemory.settings, ready), resetWorkingMemory = useMutation(api.workingMemory.reset)
  const memoryProposals = useQuery(api.memoryProposals.list, ready), proposeMemory = useMutation(api.memoryProposals.propose), confirmMemory = useMutation(api.memoryProposals.confirm), dismissMemory = useMutation(api.memoryProposals.dismiss)
  const connectorRequests = useQuery(api.connectorRequests.list, ready), createConnectorRequest = useMutation(api.connectorRequests.create), dismissConnectorRequest = useMutation(api.connectorRequests.dismiss)
  const emailTaskSuggestions = useQuery(api.emailFollowups.suggestions, ready), saveEmailTask = useMutation(api.emailFollowups.saveTask), dismissEmailTask = useMutation(api.emailFollowups.dismissTask), handleEmailMessage = useMutation(api.emailFollowups.handleMessage), retryEmailMessage = useMutation(api.emailFollowups.retry)
  const mailProposals = useQuery(api.mailFollowthrough.list, ready), editMailProposal = useMutation(api.mailFollowthrough.update), decideMailProposal = useMutation(api.mailFollowthrough.decide), reviewMailProposalReply = useMutation(api.mailFollowthrough.reviewReply), shareMailProposalCalendar = useMutation(api.mailFollowthrough.shareCalendar)
  const mailboxSettings = useQuery(api.mailbox.settings, ready), mailboxRuns = useQuery(api.mailbox.runs, ready), mailboxMessages = useQuery(api.mailbox.messages, ready), mailDrafts = useQuery(api.mailDrafts.list, ready)
  const retryMailPreparation = useMutation(api.mailFollowthrough.retry)
  const enableMailbox = useMutation(api.mailbox.enable), setMailboxPaused = useMutation(api.mailbox.setPaused), removeMailbox = useMutation(api.mailbox.remove), requestMailbox = useMutation(api.mailbox.request), continueMailboxRun = useMutation(api.mailbox.continueRun), dismissMailboxMessage = useMutation(api.mailbox.dismissMessage), shareMailboxMessage = useMutation(api.mailbox.shareMessage)
  const prepareMailReply = useMutation(api.mailDrafts.prepare), editMailDraft = useMutation(api.mailDrafts.edit), approveMailDraft = useMutation(api.mailDrafts.approveSave), reconcileMailDraft = useMutation(api.mailDrafts.reconcile)
  const approveMailSend = useMutation(api.mailSending.approve), reconcileMailSend = useMutation(api.mailSending.reconcile), reviewMailSendAgain = useMutation(api.mailSending.reviewAgain)
  const emailChecks = useQuery(api.emailWatches.recentChecks, ready)
  const reviewEmailMessage = useMutation(api.emailWatches.reviewMessage)
  const emailWatches = useQuery(api.emailWatches.list, ready), emailWatchSettings = useQuery(api.emailWatches.settings, ready)
  const createEmailWatch = useMutation(api.emailWatches.create), updateEmailWatch = useMutation(api.emailWatches.update), setEmailWatchPaused = useMutation(api.emailWatches.setPaused), removeEmailWatch = useMutation(api.emailWatches.remove), checkEmailWatch = useMutation(api.emailWatches.checkNow)
  const legacy = useQuery(api.legacy.list, ready), importLegacy = useMutation(api.legacy.importRecords)
  const requestRevision = useMutation(api.revisions.request), cancelRevision = useMutation(api.revisions.cancel)
  const retryConversation = useMutation(api.jobs.retryConversation)
  const deleteAccount = useMutation(api.privacy.deleteAccount), refreshCalendar = useAction(api.google.refreshCalendar)
  const submit = useMutation(api.jobs.submit), saveHousehold = useMutation(api.households.save), addDraft = useMutation(api.jobs.addDraft), edit = useMutation(api.jobs.edit), approve = useMutation(api.jobs.approve), revise = useMutation(api.jobs.reviseSource), cancel = useMutation(api.jobs.cancel), reconcile = useMutation(api.jobs.reconcile), connect = useAction(api.google.connect), disconnect = useMutation(api.connections.disconnect), addCaregiver = useMutation(api.pickups.addCaregiver)
  useEffect(() => {
    if (!native || auth.isLoading) return
    const handle = async (url: string) => {
      if (handledUrl.current === url) return
      handledUrl.current = url
      try {
        if (url.startsWith(`${nativeCallback}?`)) { try { await auth.handleRedirectCallback(url) } finally { await signInTransaction.clear(); await Browser.close() } }
        else if (url === nativeCallback || url.startsWith('com.dylanxzthomas.wren://google/return?') || url.startsWith('com.dylanxzthomas.wren://microsoft/return?')) await Browser.close()
      } catch (error) { setNativeError(nativeSignInReturnMessage(error)) }
    }
    const listener = NativeApp.addListener('appUrlOpen', ({ url }) => void handle(url))
    void NativeApp.getLaunchUrl().then(result => { if (result?.url) void handle(result.url) })
    return () => { void listener.then(l => l.remove()) }
  }, [auth.isLoading, auth.handleRedirectCallback])
  useEffect(() => {
    if (ready === 'skip') return
    let active = document.visibilityState === 'visible'
    const beat = () => { if (active) void presence({}).catch(() => {}) }
    const visible = () => { active = document.visibilityState === 'visible'; beat() }
    document.addEventListener('visibilitychange', visible); beat()
    const timer = setInterval(beat, 30000)
    const appListener = native ? NativeApp.addListener('appStateChange', s => { active = s.isActive; beat() }) : null
    const pushListener = native ? PushNotifications.addListener('pushNotificationActionPerformed', notification => { const id = notification.notification.data?.jobId; if (typeof id === 'string') window.location.hash = `job=${encodeURIComponent(id)}` }) : null
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); void appListener?.then(l => l.remove()); void pushListener?.then(l => l.remove()) }
  }, [ready === 'skip', presence])
  useEffect(() => {
    if (!native || !notificationSettings?.enabled) return
    void PushNotifications.checkPermissions().then(async permission => { if (permission.receive === 'granted') { const token = await registerPhone(); await saveNotifications({ enabled: true, quietStart: notificationSettings.quietStart, quietEnd: notificationSettings.quietEnd, token }) } }).catch(() => setNativeError('Notification registration needs attention in household settings.'))
  }, [notificationSettings?.enabled, notificationSettings?.quietStart, notificationSettings?.quietEnd, saveNotifications])
  const uploadPrivateFiles = async (files: File[]) => {
      const attachmentIds: Id<'attachments'>[] = []
      for (const file of files) {
        const token = (await auth.getIdTokenClaims())?.__raw
        if (!token || !import.meta.env.VITE_CONVEX_SITE_URL) throw new Error('The private upload connection is not configured.')
        const result = await fetch(`${import.meta.env.VITE_CONVEX_SITE_URL}/intake/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file })
        const value = await result.json()
        if (!result.ok) throw new Error(value.error ?? 'Upload failed; the local draft remains saved.')
        attachmentIds.push(value.id)
      }
      if (attachmentIds.length) {
        let complete = false
        for (let n = 0; n < 45; n++) {
          const results = await convex!.query(api.intake.status, { ids: attachmentIds })
          const rejected = results.find(f => f.status === 'rejected')
          if (rejected) throw new Error(rejected.error)
          if (results.every(f => f.status === 'ready')) { complete = true; break }
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        if (!complete) throw new Error('Files are still being checked. Your local draft is preserved; try again shortly.')
      }
      return attachmentIds

  }
  const client: DaymarkClient = {
    inspectCalendarEvent: (eventId, origin) => inspectCalendarEvent({ eventId: eventId as Id<'calendarFeedEvents'>, ...(origin ? { origin: { ...origin, id: origin.id as Id<'assistantRuns'> } } : {}) }),
    prepareCalendarEventChange: (preview, proposed) => prepareCalendarEventChange({ eventId: preview.eventId, feedVersion: preview.feedVersion, connectionVersion: preview.connectionVersion, selectionVersion: preview.selectionVersion, etag: preview.etag, originalHash: preview.originalHash, proposed, consent: true, ...(preview.origin ? { origin: { ...preview.origin, id: preview.origin.id as Id<'assistantRuns'> } } : {}) }),
    retryConversation: (jobId, sourceRevision) => retryConversation({ jobId: jobId as Id<'jobs'>, sourceRevision }),
    enableMailbox: (connectionId, connectionVersion, lookbackDays) => enableMailbox({ connectionId: connectionId as Id<'connections'>, connectionVersion, lookbackDays, consent: true }),
    editMailProposal: (id, version, input) => editMailProposal({ id: id as Id<'mailProposals'>, version, input }),
    decideMailProposal: (id, version, operation, until) => decideMailProposal({ id: id as Id<'mailProposals'>, version, operation, ...(until ? { until } : {}) }),
    reviewMailProposalReply: (id, version) => reviewMailProposalReply({ id: id as Id<'mailProposals'>, version }),
    shareMailProposalCalendar: (id, version, text) => shareMailProposalCalendar({ id: id as Id<'mailProposals'>, version, text, consent: true }),
    setMailboxPaused: (id, version, paused) => setMailboxPaused({ id: id as Id<'mailboxes'>, version, paused }),
    removeMailbox: (id, version) => removeMailbox({ id: id as Id<'mailboxes'>, version }),
    requestMailbox: input => requestMailbox(input),
    startVoice:(sdp,requestId)=>startVoice({sdp,requestId,consent:true,...(voiceSettings?.toolsAvailable?{toolsConsent:true as const}:{})}),
    stopVoice:(id,version)=>stopVoice({id:id as Id<'voiceSessions'>,version}),
    askSolaVoice:(id,version,callId,text,signal)=>waitForVoiceRequest(()=>requestVoice({id:id as Id<'voiceSessions'>,version,callId,text}),requestId=>convex!.query(api.voice.result,{id:id as Id<'voiceSessions'>,version,requestId:requestId as Id<'voiceRequests'>}),signal),
    retryAssistant:(id,version)=>retryAssistant({id:id as Id<'assistantRuns'>,version}),
    updatePrivateTask:(id,version,input)=>updatePrivateTask({id:id as Id<'privateTasks'>,version,...input}),
    setPrivateTaskDone:(id,version,done)=>setPrivateTaskDone({id:id as Id<'privateTasks'>,version,done}),
    removePrivateTask:(id,version)=>removePrivateTask({id:id as Id<'privateTasks'>,version}),
    reviewAssistantDraft:async(id,version,index,text,operation,consent)=>(await reviewAssistantDraft({id:id as Id<'assistantRuns'>,version,index,text,operation,...(consent?{consent:true}:{})}))??undefined,
    suggestWorkflow:(jobId,sourceRevision)=>suggestWorkflow({jobId:jobId as Id<'jobs'>,sourceRevision}),
    editLearnedWorkflow:(id,version,value)=>editLearnedWorkflow({id:id as Id<'learnedWorkflows'>,version,value}),
    approveLearnedWorkflow:(id,version,value,shareConfirmed)=>approveLearnedWorkflow({id:id as Id<'learnedWorkflows'>,version,value,shareConfirmed}),
    dismissLearnedWorkflow:(id,version)=>dismissLearnedWorkflow({id:id as Id<'learnedWorkflows'>,version}),
    discoverMailAttachments:(messageId,version)=>discoverMailAttachments({messageId:messageId as Id<'mailMessages'>,version}),
    readMailAttachment:(id,version,descriptorHash)=>readMailAttachment({id:id as Id<'mailAttachments'>,version,descriptorHash,consent:true}),
    connectCalendarRead:async(provider)=>{const url=await(provider==='microsoft'?connectMicrosoft({purpose:'calendar_read',native}):connect({purpose:'calendar_read',native}));if(native)await Browser.open({url});else window.location.assign(url)},
    connectCalendarEditing:async(provider)=>{const url=await(provider==='microsoft'?connectMicrosoft({purpose:'calendar',native}):connect({purpose:'calendar_events',native}));if(native)await Browser.open({url});else window.location.assign(url)},
    retryMailPreparation: (runId, runVersion, agentVersion) => retryMailPreparation({ runId: runId as Id<'mailRuns'>, runVersion, agentVersion }),
    continueMailboxRun: (id, version) => continueMailboxRun({ id: id as Id<'mailRuns'>, version }),
    dismissMailboxMessage: (id, version, dismissed) => dismissMailboxMessage({ id: id as Id<'mailMessages'>, version, dismissed }),
    shareMailboxMessage: (id, version, text) => shareMailboxMessage({ id: id as Id<'mailMessages'>, version, text, consent: true }),
    connectMailDrafts: async () => { const url = await connect({ purpose: 'compose', native }); if (native) await Browser.open({ url }); else window.location.assign(url) },
    prepareMailReply: (messageId, version, instruction) => prepareMailReply({ messageId: messageId as Id<'mailMessages'>, version, instruction }),
    editMailDraft: (id, version, input) => editMailDraft({ id: id as Id<'mailDrafts'>, version, input }),
    approveMailDraft: (id, version, input) => approveMailDraft({ id: id as Id<'mailDrafts'>, version, input }),
    reconcileMailDraft: (id, version) => reconcileMailDraft({ id: id as Id<'mailDrafts'>, version }),
    approveMailSend: (id, version, input) => approveMailSend({ id: id as Id<'mailDrafts'>, version, input }),
    reconcileMailSend: (id, version) => reconcileMailSend({ id: id as Id<'mailDrafts'>, version }),
    reviewMailSendAgain: (id, version) => reviewMailSendAgain({ id: id as Id<'mailDrafts'>, version }),
    createConnectorRequest: (input, requestId) => createConnectorRequest({ ...input, requestId }),
    dismissConnectorRequest: (id, version) => dismissConnectorRequest({ id: id as Id<'connectorRequests'>, version }),
    connectEmailWatch: async () => { const url = await connect({ purpose: 'watch', native }); if (native) await Browser.open({ url }); else window.location.assign(url) },
    createEmailWatch: (definition, requestId, connectionId) => createEmailWatch({ ...definition, requestId, connectionId: connectionId as Id<'connections'>, consent: true }),
    updateEmailWatch: (id, version, definition) => updateEmailWatch({ id: id as Id<'emailWatches'>, version, ...definition, consent: true }),
    setEmailWatchPaused: (id, version, paused) => setEmailWatchPaused({ id: id as Id<'emailWatches'>, version, paused }),
    removeEmailWatch: (id, version) => removeEmailWatch({ id: id as Id<'emailWatches'>, version }),
    saveEmailTask: (id, version, sourceRevision, input) => saveEmailTask({ id: id as Id<'emailTaskSuggestions'>, version, sourceRevision, input }),
    dismissEmailTask: (id, version, sourceRevision) => dismissEmailTask({ id: id as Id<'emailTaskSuggestions'>, version, sourceRevision }),
    handleEmailMessage: (jobId, sourceRevision, handlingVersion, operation, until) => handleEmailMessage({ jobId: jobId as Id<'jobs'>, sourceRevision, handlingVersion, operation, ...(until !== undefined ? { until } : {}) }),
    retryEmailMessage: (jobId, sourceRevision) => retryEmailMessage({ jobId: jobId as Id<'jobs'>, sourceRevision }),
    reviewEmailMessage: (jobId, sourceRevision) => reviewEmailMessage({ jobId: jobId as Id<'jobs'>, sourceRevision }),
    checkEmailWatch: (id, version) => checkEmailWatch({ id: id as Id<'emailWatches'>, version }),
    proposeMemory: input => proposeMemory({ ...input, sourceJobId: input.sourceJobId as Id<'jobs'> | undefined }),
    confirmMemory: (id, version, value, replaceFactId, replaceFactVersion) => confirmMemory({ id: id as Id<'memoryProposals'>, version, value, replaceFactId: replaceFactId as Id<'memoryFacts'> | undefined, replaceFactVersion }),
    dismissMemory: (id, version) => dismissMemory({ id: id as Id<'memoryProposals'>, version }),
    createRoutine: (definition, requestId) => createRoutine({ definition, requestId, enabled: true }),
    updateRoutine: (id, version, definition) => updateRoutine({ id: id as Id<'routines'>, version, definition }),
    setRoutinePaused: (id, version, paused) => setRoutinePaused({ id: id as Id<'routines'>, version, paused }),
    removeRoutine: (id, version) => removeRoutine({ id: id as Id<'routines'>, version }),
    routineOccurrences: async id => (await convex!.query(api.routines.occurrences, { id: id as Id<'routines'>, paginationOpts: { numItems: 50, cursor: null } })).page.map(r => ({ ...r, id: r._id })) as RoutineRun[],
    createMailRoutine: (definition, requestId) => createMailRoutine({ definition, requestId }),
    updateMailRoutine: (id, version, definition) => updateMailRoutine({ id: id as Id<'mailRoutines'>, version, definition }),
    setMailRoutinePaused: (id, version, paused) => setMailRoutinePaused({ id: id as Id<'mailRoutines'>, version, paused }),
    removeMailRoutine: (id, version) => removeMailRoutine({ id: id as Id<'mailRoutines'>, version }),
    mailRoutineHistory: id => convex!.query(api.mailRoutines.history, { id: id as Id<'mailRoutines'> }),
    createPersonalTask: (input, requestId) => createPersonalTask({ ...input, requestId }),
    updatePersonalTask: (id, version, changes) => updatePersonalTask({ id: id as Id<'personalTasks'>, version, changes }),
    setPersonalTaskDone: (id, version, done) => setPersonalTaskDone({ id: id as Id<'personalTasks'>, version, done }),
    removePersonalTask: (id, version) => removePersonalTask({ id: id as Id<'personalTasks'>, version }),
    scheduleRequest: (text, runAt, requestId) => scheduleRequest({ text, runAt, requestId }),
    saveHouseholdName: name => saveHouseholdName({ name }),
    saveLibraryArtifact: actionId => saveLibraryArtifact({ actionId: actionId as Id<'actions'> }),
    savePreferences: value => savePreferences(value),
    updateLibrary: (id, version, changes) => updateLibrary({ id: id as Id<'library'>, version, changes }),
    removeLibrary: (id, version) => removeLibrary({ id: id as Id<'library'>, version }),
    keepLibraryFile: (jobId, fileId) => storeLibraryFiles({ ids: [fileId as Id<'attachments'>], jobId: jobId as Id<'jobs'>, collection: '' }),
    uploadLibrary: async (files, collection, childId) => {
      validateLibraryFiles(files.map(f => ({ size: f.size, mediaType: f.type || (/\.heic$/i.test(f.name) ? 'image/heic' : /\.pdf$/i.test(f.name) ? 'application/pdf' : '') })))
      return storeLibraryFiles({ ids: await uploadPrivateFiles(files), collection, ...(childId ? { childId } : {}) })
    },
    readLibraryFile: async id => { const token = (await auth.getIdTokenClaims())?.__raw; if (!token) throw new Error('Sign in to view this file.'); const response = await fetch(`${import.meta.env.VITE_CONVEX_SITE_URL}/library/file?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } }); if (!response.ok) throw new Error('This saved file is no longer available.'); return response.blob() },
    connectNativeCalendar: apple.connect, selectNativeCalendar: apple.select,
    savePickupDelivery: channel => savePickupDelivery({ channel }),
    respondToPickup: (id, revision, response, suggestion) => respondToPickup({ requestId: id as Id<'pickupRequests'>, revision, response, suggestion }),
    requestRevision: (actionId, revision, instruction) => requestRevision({ actionId: actionId as Id<'actions'>, revision, instruction }),
    cancelRevision: (actionId, revision) => cancelRevision({ actionId: actionId as Id<'actions'>, revision }),
    readFile: async id => { const token = (await auth.getIdTokenClaims())?.__raw; if (!token) throw new Error('Sign in to view this file.'); const result = await fetch(`${import.meta.env.VITE_CONVEX_SITE_URL}/intake/file?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } }); if (!result.ok) throw new Error('The original file is no longer available.'); return result.blob() },
    saveNotifications: async (enabled, quietStart, quietEnd) => { if (!enabled) { await saveNotifications({ enabled, quietStart, quietEnd }); await unregisterPhone(token => unregister({ token })); return } const token = await registerPhone(); await saveNotifications({ enabled, quietStart, quietEnd, token }) },
    enableForwarding: () => enableForwarding({}), retryForwarded: id => retryForwarded({ id: id as Id<'inbound'> }),
    saveFact: (value, id, version) => saveFact({ value, ...(id ? { id: id as Id<'memoryFacts'>, version } : {}) }),
    removeFact: (id, version) => removeFact({ id: id as Id<'memoryFacts'>, version }),
    updateCaregiver: (id, name, email, childIds) => updateCaregiver({ id: id as Id<'caregivers'>, name, email, childIds }),
    signIn: async () => { setNativeError(''); await auth.loginWithRedirect(native ? { openUrl: async url => { await signInTransaction.save(); await Browser.open({ url }) } } : { appState: { connectionReturn: connectionReturn(window.location.search) } }) },
    signOut: async () => { try { if (ready !== 'skip') await unregisterPhone(token => unregister({ token })) } finally { if (native) await signInTransaction.clear(); await auth.logout({ logoutParams: { returnTo: native ? nativeCallback : window.location.origin }, ...(native ? { openUrl: async (url: string) => { await Browser.open({ url }) } } : {}) }) } },
    submit: async (text, files = []) => submit({ text, attachmentIds: await uploadPrivateFiles(files) }), saveHousehold: (timezone, children) => saveHousehold({ timezone, children }),
    addDraft: (jobId, payload) => addDraft({ jobId: jobId as Id<'jobs'>, payload }), edit: (actionId, revision, payload) => edit({ actionId: actionId as Id<'actions'>, revision, payload }),
    reviewPickupEmail: (id, revision, payload) => convex!.query(api.pickupMail.review, { actionId: id as Id<'actions'>, revision, payload }),
    approve: (actions, reviewMs) => approve({ ...(reviewMs !== undefined ? { reviewMs } : {}), actions: actions.map(a => ({ id: a.id as Id<'actions'>, revision: a.revision, ...(a.selectionVersion !== undefined ? { selectionVersion: a.selectionVersion } : {}), ...(a.nativeCalendar ? { nativeCalendar: a.nativeCalendar } : {}), ...(a.deliveryChannel ? { deliveryChannel: a.deliveryChannel } : {}), ...(a.pickupEmailHash ? { pickupEmailHash: a.pickupEmailHash } : {}) })) }),
    importLegacy: async (origin, json) => { const value = json ?? (await Preferences.get({ key: 'wren.household.v1' })).value; if (!value) throw new Error('No legacy phone records were found.'); return importLegacy({ origin, json: value }) },
    resetWorkingMemory: version => resetWorkingMemory({ version }),
    deleteAccount: async () => { await deleteAccount({ confirmation: 'DELETE' }); await Preferences.remove({ key: 'daymark.request-draft.v1' }); await saveFiles([]) }, refreshCalendar: actionId => usesApple(actionId) ? apple.refresh(actionId) : refreshCalendar({ actionId: actionId as Id<'actions'> }),
    reviseSource: (jobId, revision, text) => revise({ jobId: jobId as Id<'jobs'>, revision, text }), cancel: jobId => cancel({ jobId: jobId as Id<'jobs'> }), reconcile: actionId => usesApple(actionId) ? apple.reconcile(actionId) : reconcile({ actionId: actionId as Id<'actions'> }),
    chooseAccount: (purpose, id, version) => chooseAccount({ purpose, id: id as Id<'connections'>, version }),
    connect: async (purpose, provider = 'google') => { const url = await (provider === 'microsoft' ? connectMicrosoft({ purpose: purpose === 'gmail' ? 'email' : purpose, native }) : connect({ purpose, native })); if (native) await Browser.open({ url }); else window.location.assign(url) }, disconnect: id => disconnect(id ? { id: id as Id<'connections'> } : {}), addCaregiver: (name, email, childIds) => addCaregiver({ name, email, childIds }),
  }
  const notice = authenticationNotice({ identityLoading: auth.isLoading, identityAuthenticated: auth.isAuthenticated, backendLoading: session.isLoading, backendAuthenticated: session.isAuthenticated, error: auth.error })
  if (!session.isAuthenticated) {
    const finishConnection = !native && connectionReturn(window.location.search) === 'connected' && !auth.isLoading && !session.isLoading
    return <>{nativeError && <p className="dm-error" role="alert">{nativeError}</p>}{notice && <aside className={notice.pending ? 'dm-notice' : 'dm-error'} role={notice.pending ? 'status' : 'alert'} aria-label="Account sign-in"><p>{notice.message}</p>{notice.reset && <button onClick={() => void client.signOut().catch(() => setNativeError('Sign-out could not finish. Try again from Household.'))}>Reset sign-in</button>}</aside>}{finishConnection && <aside className="dm-notice" role="status"><p>Continue sign-in to finish your Gmail connection. Your device workspace is still here.</p><button onClick={() => void client.signIn().catch(() => setNativeError('Sign-in could not open. Try again from Household.'))}>Continue sign-in</button></aside>}<DeviceApplication signIn={client.signIn} /></>
  }
  return <>{apple.error && <p role="alert" className="dm-error">{apple.error}</p>}{nativeError && <p role="alert" className="dm-error">{nativeError}</p>}{notice && <p className="dm-error" role="alert">{notice.message}</p>}<Daymark state={{ configured: true, signedIn: session.isAuthenticated, loading: session.isLoading || auth.isLoading, household: household ?? null, pickupDelivery, incomingPickups, jobs: (jobs ?? []).map(job => ({ ...job, createdAt: job._creationTime })) as DaymarkState['jobs'], personalTasks, memoryProposals, workingMemory, connectorRequests, emailWatches, emailWatchSettings, emailChecks, emailTaskSuggestions, mailboxSettings, mailboxRuns, mailboxMessages, mailDrafts, mailProposals, ownerKey:auth.user?.sub, voiceSettings, assistantRuns, privateTasks:privateTasks?.tasks, privateTasksLimited:privateTasks?.limited, learnedWorkflows, mailAttachments, calendarAgenda, routines: routines?.map(r => ({ ...r, id: r._id })) as Routine[] | undefined, routineSettings, mailRoutines, library, preferences, plan: plan ?? [], caregivers: caregivers ?? [], arrangements: arrangements ?? [], connection: connection ?? null, accounts, nativeCalendar: apple.state, notifications: notificationSettings, forwarding, facts: facts as DaymarkState['facts'], legacy: legacy ?? [] }} client={client} /></>
}
// This route mounts only the scoped pickup page during caregiver sign-in.
// It never runs the connected household queries or account-creation flow.
function AuthenticatedApplication() {
  const auth = useAuth0(), session = useConvexAuth()
  const secret = pickupSecret(window.location.hash)
  if (auth.isLoading) return <p className="dm-notice" role="status">Restoring sign-in…</p>
  if (secret || new URLSearchParams(window.location.hash.slice(1)).has('pickup')) return <CaregiverPage identity={{
    loading: session.isLoading,
    authenticated: session.isAuthenticated,
    signIn: method => auth.loginWithRedirect(caregiverSignInOptions(window.location.hash, method)),
  }} />
  return <Connected />
}
function NativeIdentityProvider() {
  const [client] = useState(() => new NativeAuthClient({ domain: config.domain, clientId: config.clientId, redirectUri: nativeCallback, cache: nativeCache }))
  return <Auth0Provider client={client} onRedirectCallback={() => {}}><ConvexProviderWithAuth0 client={convex!}><AuthenticatedApplication /></ConvexProviderWithAuth0></Auth0Provider>
}
export default function Application() {
  const [restored, setRestored] = useState(!native), [restoreError, setRestoreError] = useState(false)
  useEffect(() => { if (native && convex && config.domain && config.clientId) void signInTransaction.restore().then(() => setRestored(true)).catch(() => setRestoreError(true)) }, [])
  const pickup = new URLSearchParams(window.location.hash.slice(1)).has('pickup')
  if (!convex || !config.domain || !config.clientId) return pickup ? convex ? <ConvexProvider client={convex}><CaregiverPage /></ConvexProvider> : <p className="dm-notice">Private response service is not configured.</p> : <DeviceApplication />
  if (!restored) return <p className="dm-notice" role="status">{restoreError ? 'Secure sign-in storage is unavailable. Unlock the phone and reopen Daymark; your unsent draft is preserved.' : 'Restoring sign-in…'}</p>
  if (native) return <NativeIdentityProvider />
  return <Auth0Provider domain={config.domain} clientId={config.clientId} authorizationParams={{ redirect_uri: window.location.origin }} {...browserAuthOptions} onRedirectCallback={appState => { window.history.replaceState({}, document.title, signInReturnPath(appState)) }}><ConvexProviderWithAuth0 client={convex}><AuthenticatedApplication /></ConvexProviderWithAuth0></Auth0Provider>
}
