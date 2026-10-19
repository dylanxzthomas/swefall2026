import type { PickupEmailReview } from '../../../shared/pickupEmail'
import type { AskSolaVoice, VoiceSettings, VoiceSession } from '../../../shared/voice'
import type { CoordinatorView } from '../../../shared/assistantCoordinator'
import type { CalendarAgenda, SavedCalendarIdentity } from '../../../shared/calendarPlan'
import type { CoordinatorCalendarOrigin } from '../../../shared/assistantCoordinator'
import type { ExternalCalendarPreview } from '../../../convex/calendarReading'
import type { CalendarDraft } from '../../../shared/daymark'
import type { PrivateTask, PrivateTaskInput } from '../../../shared/privateTasks'
import type { LearnedProposal } from '../../../shared/learnedWorkflows'
import type { PrivateMailAttachment } from '../../../shared/mailAttachments'
import type { MailProposalInput, PrivateMailProposal } from '../../../shared/mailFollowthrough'
import type { ConnectorRequest, ConnectorRequestInput } from '../../../shared/connectorRequests'
import type { LibraryItem } from '../../../shared/library'
import type { PersonalTask, PersonalTaskInput } from '../../../shared/tasks'
import type { AssistantAvatar } from '../../../shared/persona'
import type { Routine, RoutineDefinition, RoutineRun } from '../../../shared/routines'
import type { MailRoutine, MailRoutineDefinition, MailRoutineOccurrence } from '../../../shared/mailRoutines'
import type { EmailWatchDefinition, EmailWatchSettings, EmailWatchSummary } from '../../../shared/emailWatches'
import type { MemoryProposal } from '../../../shared/memoryProposals'
import type { EmailTaskSuggestion } from '../../../shared/emailTasks'
import type { EmailCheck, EmailTriage } from '../../../shared/emailTriage'
import type { MailboxSettings, MailboxRun, PrivateMailMessage, PrivateMailDraft, MailboxRequest, PrivateReplyInput } from '../../../shared/mailbox'
export type { PersonalTask, PersonalTaskInput } from '../../../shared/tasks'
export type { LibraryItem } from '../../../shared/library'
import type { FamilyFact } from '../../../shared/memory'
import type { Payload, ActionStatus } from '../../../shared/daymark'
export type Child = { id: string; name: string }
export type Receipt = { _id: string; revision?: number; providerId?: string; requestId?: string; outcome: string; verifiedAt: number; url?: string }
export type Deliverable = { pickupEmail?: boolean; _id: string; revision: number; payload: Payload; status: ActionStatus; provider?: 'google' | 'microsoft' | 'apple'; error?: string; revisionRequest?: { instruction: string; startedAt: number }; revisionNote?: string; before?: { payload: Payload; provider?: 'google' | 'microsoft' | 'apple' }; receipts: Receipt[] }
export type GmailSourceInfo = { sender: string; subject: string; receivedAt: number; extraction: { format: 'plain' | 'html' | 'snippet' | 'unavailable'; truncated: boolean; incomplete: boolean; attachments: boolean; issues: string[] } }
export type Job = { _id: string; assistantRunId?:string; emailTriage?: EmailTriage; emailPreparationFailed?: boolean; conversation?: boolean; createdAt?: number; scheduledFor?: number; preparing: boolean; cancelled: boolean; clarification: string; source: { text?: string; revision: number; email?: GmailSourceInfo } | null; actions: Deliverable[]; files?: { id: string; name: string; hash: string; size: number; mediaType: string }[] }
export type PlanEvent = SavedCalendarIdentity & { _id: string; actionId: string; payload: Payload; url?: string }
export type Caregiver = { _id: string; name: string; email: string; childIds: string[]; deliveryChannel?: 'email' | 'app' }
export type IncomingPickup = { id: string; revision: number; child: string; date: string; time: string; timezone: string; location: string; message: string; deadline: string; reminder: boolean }
export type Arrangement = { id: string; status: string; response?: string; respondedAt?: number; actionId: string; caregiver?: string; suggestion?: string; followUpStatus?: string; payload?: Payload }
export type ConnectedAccount = { id: string; provider: 'google' | 'microsoft' | 'apple'; nativeDeviceId?: string; version?: number; status: string; scopes: string[]; calendarId?: string; calendarName?: string; email?: string; calendar: boolean; mail: boolean }
export type NativeCalendarState = { available: boolean; permission: 'prompt' | 'granted' | 'denied'; calendars: { id: string; title: string; account: string }[]; selectedId?: string; version: number }
export interface DaymarkState {
  ownerKey?:string; voiceSettings?:VoiceSettings;
  assistantRuns?: CoordinatorView[];
  privateTasks?: PrivateTask[];
  privateTasksLimited?: boolean;
  learnedWorkflows?: LearnedProposal[];
  mailAttachments?: PrivateMailAttachment[];
  calendarAgenda?: CalendarAgenda;

  connectorRequests?: ConnectorRequest[];
  library?: LibraryItem[];
  preferences?: { parentName: string; assistantName: string; avatar?: AssistantAvatar };
  personalTasks?: PersonalTask[];
  routines?: Routine[];
  mailRoutines?: MailRoutine[];
  routineSettings?: { preparationModelConfigured: boolean; catchUp: 'latest_only'; maxSaved: number };
  memoryProposals?: MemoryProposal[];
  workingMemory?: { version: number; excerptCount: number; resetAt?: number };
  emailWatches?: EmailWatchSummary[];
  emailWatchSettings?: EmailWatchSettings;
  emailChecks?: EmailCheck[];
  emailTaskSuggestions?: EmailTaskSuggestion[];
  mailboxSettings?: MailboxSettings;
  mailboxRuns?: MailboxRun[];
  mailboxMessages?: PrivateMailMessage[];
  mailDrafts?: PrivateMailDraft[];
  mailProposals?: PrivateMailProposal[];
  storage?: 'device';
  nativeCalendar?: NativeCalendarState;
  accounts?: { items: ConnectedAccount[]; calendarId?: string; emailId?: string; version: number; configured: { google: boolean; microsoft: boolean } };
  accountAvailable?: boolean;
  configured: boolean; signedIn: boolean; loading?: boolean; household: { name?: string; timezone: string; children: Child[] } | null;
  jobs: Job[]; plan: PlanEvent[]; caregivers: Caregiver[]; arrangements: Arrangement[];
  pickupDelivery?: { verified: boolean; email?: string; channel: 'email' | 'app' };
  incomingPickups?: IncomingPickup[];
  notifications?: { enabled: boolean; quietStart: string; quietEnd: string; configured: boolean };
  forwarding?: { configured: boolean; address: string | null; sender?: string; notices: { id: string; status: string; title?: string; sender?: string; reason?: string }[] };
  facts?: { _id: string; key: string; value: FamilyFact; version: number; source: string; updatedAt: number; scope: string }[];
  legacy?: { _id: string; items: { title: string; date: string | null; notes: string }[] }[];
  connection: { status: string; scopes: string[]; calendarId?: string; email?: string } | null;
}
export interface DaymarkClient {
  reviewPickupEmail?(id: string, revision: number, payload: Extract<Payload, { kind: 'pickup' }>): Promise<PickupEmailReview>;
  inspectCalendarEvent?(eventId: string, origin?: CoordinatorCalendarOrigin): Promise<ExternalCalendarPreview>;
  prepareCalendarEventChange?(preview: ExternalCalendarPreview, proposed: CalendarDraft): Promise<string>;
  updatePrivateTask?(id: string, version: number, input: PrivateTaskInput): Promise<number>;
  setPrivateTaskDone?(id: string, version: number, done: boolean): Promise<number>;
  removePrivateTask?(id: string, version: number): Promise<unknown>;
  editMailProposal?(id: string, version: number, input: MailProposalInput): Promise<number>;
  decideMailProposal?(id: string, version: number, operation: 'keep' | 'done' | 'reopen' | 'dismiss' | 'snooze', until?: number): Promise<number>;
  reviewMailProposalReply?(id: string, version: number): Promise<string>;
  shareMailProposalCalendar?(id: string, version: number, text: string): Promise<string>;
  resetWorkingMemory?(version: number): Promise<number>;
  retryConversation?(jobId: string, sourceRevision: number): Promise<number>;
  enableMailbox?(connectionId: string, connectionVersion: number, lookbackDays: number): Promise<unknown>;
  setMailboxPaused?(id: string, version: number, paused: boolean): Promise<unknown>;
  removeMailbox?(id: string, version: number): Promise<unknown>;
  requestMailbox?(input: MailboxRequest & { requestId: string; request: string }): Promise<string>;
  startVoice?(sdp:string,requestId:string):Promise<VoiceSession>;
  stopVoice?(id:string,version:number):Promise<unknown>;
  askSolaVoice?:AskSolaVoice;
  retryAssistant?(id:string,version:number):Promise<unknown>;
  reviewAssistantDraft?(id:string,version:number,index:number,text:string,operation:'keep'|'done'|'dismiss'|'share'|'reply',consent:boolean):Promise<string|undefined>;
  suggestWorkflow?(jobId:string,sourceRevision:number):Promise<unknown>;
  editLearnedWorkflow?(id:string,version:number,value:unknown):Promise<number>;
  approveLearnedWorkflow?(id:string,version:number,value:unknown,shareConfirmed:boolean):Promise<unknown>;
  dismissLearnedWorkflow?(id:string,version:number):Promise<unknown>;
  discoverMailAttachments?(messageId:string,version:number):Promise<{incomplete:boolean;count:number}>;
  readMailAttachment?(id:string,version:number,descriptorHash:string):Promise<number>;
  connectCalendarRead?(provider:'google'|'microsoft'):Promise<void>;
  connectCalendarEditing?(provider:'google'|'microsoft'):Promise<void>;
  retryMailPreparation?(runId: string, runVersion: number, agentVersion: number): Promise<number>;
  continueMailboxRun?(id: string, version: number): Promise<unknown>;
  dismissMailboxMessage?(id: string, version: number, dismissed: boolean): Promise<unknown>;
  shareMailboxMessage?(id: string, version: number, text: string): Promise<string>;
  connectMailDrafts?(): Promise<unknown>;
  prepareMailReply?(messageId: string, version: number, instruction: string): Promise<string>;
  editMailDraft?(id: string, version: number, input: PrivateReplyInput): Promise<number>;
  approveMailDraft?(id: string, version: number, input: PrivateReplyInput): Promise<number>;
  reconcileMailDraft?(id: string, version: number): Promise<number>;
  approveMailSend?(id: string, version: number, input: PrivateReplyInput): Promise<number>;
  reconcileMailSend?(id: string, version: number): Promise<number>;
  reviewMailSendAgain?(id: string, version: number): Promise<number>;
  createConnectorRequest?(input: ConnectorRequestInput, requestId: string): Promise<string>;
  dismissConnectorRequest?(id: string, version: number): Promise<unknown>;
  connectEmailWatch?(): Promise<unknown>;
  createEmailWatch?(definition: EmailWatchDefinition, requestId: string, connectionId: string): Promise<unknown>;
  updateEmailWatch?(id: string, version: number, definition: EmailWatchDefinition): Promise<unknown>;
  setEmailWatchPaused?(id: string, version: number, paused: boolean): Promise<unknown>;
  removeEmailWatch?(id: string, version: number): Promise<unknown>;
  checkEmailWatch?(id: string, version: number): Promise<unknown>;
  saveEmailTask?(id: string, version: number, sourceRevision: number, input: PersonalTaskInput): Promise<unknown>;
  dismissEmailTask?(id: string, version: number, sourceRevision: number): Promise<unknown>;
  handleEmailMessage?(jobId: string, sourceRevision: number, handlingVersion: number, operation: 'dismiss' | 'snooze' | 'restore', until?: number): Promise<unknown>;
  retryEmailMessage?(jobId: string, sourceRevision: number): Promise<unknown>;
  reviewEmailMessage?(jobId: string, sourceRevision: number): Promise<unknown>;
  createRoutine?(definition: RoutineDefinition, requestId: string): Promise<string>;
  updateRoutine?(id: string, version: number, definition: RoutineDefinition): Promise<unknown>;
  setRoutinePaused?(id: string, version: number, paused: boolean): Promise<unknown>;
  removeRoutine?(id: string, version: number): Promise<unknown>;
  routineOccurrences?(id: string): Promise<RoutineRun[]>;
  createMailRoutine?(definition: MailRoutineDefinition, requestId: string): Promise<string>;
  updateMailRoutine?(id: string, version: number, definition: MailRoutineDefinition): Promise<unknown>;
  setMailRoutinePaused?(id: string, version: number, paused: boolean): Promise<number>;
  removeMailRoutine?(id: string, version: number): Promise<unknown>;
  mailRoutineHistory?(id: string): Promise<MailRoutineOccurrence[]>;
  proposeMemory?(input: { requestId: string; text: string; value?: FamilyFact; sourceJobId?: string; sourceRevision?: number }): Promise<string>;
  confirmMemory?(id: string, version: number, value: FamilyFact, replaceFactId?: string, replaceFactVersion?: number): Promise<unknown>;
  dismissMemory?(id: string, version: number): Promise<unknown>;
  createPersonalTask?(input: PersonalTaskInput, requestId: string): Promise<unknown>;
  updatePersonalTask?(id: string, version: number, input: PersonalTaskInput): Promise<unknown>;
  setPersonalTaskDone?(id: string, version: number, done: boolean): Promise<unknown>;
  removePersonalTask?(id: string, version: number): Promise<unknown>;
  scheduleRequest?(text: string, runAt: number, requestId: string): Promise<string>;
  saveHouseholdName?(name: string): Promise<unknown>;
  saveLibraryArtifact?(actionId: string): Promise<unknown>;
  uploadLibrary?(files: File[], collection: string, childId?: string): Promise<unknown>;
  keepLibraryFile?(jobId: string, fileId: string): Promise<unknown>;
  updateLibrary?(id: string, version: number, changes: { title: string; collection: string; childId?: string; pinned: boolean }): Promise<unknown>;
  removeLibrary?(id: string, version: number): Promise<unknown>;
  readLibraryFile?(id: string): Promise<Blob>;
  savePreferences?(value: { parentName: string; assistantName: string; avatar?: AssistantAvatar }): Promise<unknown>;
  savePickupDelivery(channel: 'email' | 'app'): Promise<unknown>;
  respondToPickup(id: string, revision: number, response: 'accept' | 'decline' | 'suggest', suggestion: string): Promise<unknown>;
  readFile(id: string): Promise<Blob>;
  saveNotifications(enabled: boolean, quietStart: string, quietEnd: string): Promise<unknown>;
  enableForwarding(): Promise<unknown>;
  retryForwarded(id: string): Promise<unknown>;
  saveFact(value: FamilyFact, id?: string, version?: number): Promise<unknown>;
  removeFact(id: string, version: number): Promise<unknown>;
  updateCaregiver(id: string, name: string, email: string, childIds: string[]): Promise<unknown>;
  signIn(): Promise<void>; signOut(): Promise<void>;
  submit(text: string, files?: File[]): Promise<string>;
  saveHousehold(timezone: string, children: Child[]): Promise<unknown>;
  addDraft(jobId: string, payload: Payload): Promise<unknown>;
  edit(actionId: string, revision: number, payload: Payload): Promise<unknown>;
  requestRevision(actionId: string, revision: number, instruction: string): Promise<number>;
  cancelRevision(actionId: string, revision: number): Promise<unknown>;
  approve(actions: { id: string; revision: number; selectionVersion?: number; nativeCalendar?: { calendarId: string; version: number }; deliveryChannel?: 'email' | 'app'; pickupEmailHash?: string }[], reviewMs?: number): Promise<unknown>;
  reviseSource(jobId: string, revision: number, text: string): Promise<unknown>;
  importLegacy(origin: 'phone' | 'sqlite-export', json?: string): Promise<unknown>;
  deleteAccount(): Promise<unknown>;
  refreshCalendar(actionId: string): Promise<unknown>;
  cancel(jobId: string): Promise<unknown>; reconcile(actionId: string): Promise<unknown>;
  connect(purpose: 'calendar' | 'gmail', provider?: 'google' | 'microsoft'): Promise<unknown>; disconnect(id?: string): Promise<unknown>;
  chooseAccount?(purpose: 'calendar' | 'email', id: string, version: number): Promise<unknown>;
  connectNativeCalendar?(): Promise<unknown>;
  selectNativeCalendar?(id: string | null): Promise<unknown>;
  addCaregiver(name: string, email: string, childIds: string[]): Promise<unknown>;
  exportCalendar?(actionId: string): Promise<unknown>;
}
