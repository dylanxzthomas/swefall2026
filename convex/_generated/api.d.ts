/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as apns from "../apns.js";
import type * as apple from "../apple.js";
import type * as appointmentBookings from "../appointmentBookings.js";
import type * as assistantContext from "../assistantContext.js";
import type * as assistantCoordinator from "../assistantCoordinator.js";
import type * as assistantMail from "../assistantMail.js";
import type * as assistantSharing from "../assistantSharing.js";
import type * as calcom from "../calcom.js";
import type * as calendarAssistance from "../calendarAssistance.js";
import type * as calendarChanges from "../calendarChanges.js";
import type * as calendarFeeds from "../calendarFeeds.js";
import type * as calendarReading from "../calendarReading.js";
import type * as connections from "../connections.js";
import type * as connectorRequests from "../connectorRequests.js";
import type * as conversationValidation from "../conversationValidation.js";
import type * as coordinatorWorker from "../coordinatorWorker.js";
import type * as crons from "../crons.js";
import type * as dependencies from "../dependencies.js";
import type * as emailFiles from "../emailFiles.js";
import type * as emailFollowups from "../emailFollowups.js";
import type * as emailWatchRules from "../emailWatchRules.js";
import type * as emailWatches from "../emailWatches.js";
import type * as execution from "../execution.js";
import type * as files from "../files.js";
import type * as forwarding from "../forwarding.js";
import type * as gmailAttachments from "../gmailAttachments.js";
import type * as gmailDraftDiagnosticRules from "../gmailDraftDiagnosticRules.js";
import type * as gmailDraftDiagnosticSummary from "../gmailDraftDiagnosticSummary.js";
import type * as gmailDraftPreimage from "../gmailDraftPreimage.js";
import type * as gmailDrafts from "../gmailDrafts.js";
import type * as gmailMailbox from "../gmailMailbox.js";
import type * as gmailSending from "../gmailSending.js";
import type * as gmailWatch from "../gmailWatch.js";
import type * as google from "../google.js";
import type * as googleAdapter from "../googleAdapter.js";
import type * as googleCrypto from "../googleCrypto.js";
import type * as households from "../households.js";
import type * as http from "../http.js";
import type * as identityDeletion from "../identityDeletion.js";
import type * as inbound from "../inbound.js";
import type * as intake from "../intake.js";
import type * as jobs from "../jobs.js";
import type * as learnedWorkflows from "../learnedWorkflows.js";
import type * as legacy from "../legacy.js";
import type * as library from "../library.js";
import type * as mailAgent from "../mailAgent.js";
import type * as mailAttachments from "../mailAttachments.js";
import type * as mailConversation from "../mailConversation.js";
import type * as mailDrafts from "../mailDrafts.js";
import type * as mailFollowthrough from "../mailFollowthrough.js";
import type * as mailRoutineRetention from "../mailRoutineRetention.js";
import type * as mailRoutines from "../mailRoutines.js";
import type * as mailSending from "../mailSending.js";
import type * as mailbox from "../mailbox.js";
import type * as memory from "../memory.js";
import type * as memoryProposals from "../memoryProposals.js";
import type * as memoryRules from "../memoryRules.js";
import type * as microsoft from "../microsoft.js";
import type * as microsoftAdapter from "../microsoftAdapter.js";
import type * as modelContext from "../modelContext.js";
import type * as notifications from "../notifications.js";
import type * as personalTasks from "../personalTasks.js";
import type * as pickupAlternatives from "../pickupAlternatives.js";
import type * as pickupConflicts from "../pickupConflicts.js";
import type * as pickupDelivery from "../pickupDelivery.js";
import type * as pickupFollowup from "../pickupFollowup.js";
import type * as pickupMail from "../pickupMail.js";
import type * as pickupMailWorker from "../pickupMailWorker.js";
import type * as pickupMailRules from "../pickupMailRules.js";
import type * as pickupGmailAdapter from "../pickupGmailAdapter.js";
import type * as pickupIdentity from "../pickupIdentity.js";
import type * as pickups from "../pickups.js";
import type * as preparation from "../preparation.js";
import type * as privacy from "../privacy.js";
import type * as privateTasks from "../privateTasks.js";
import type * as providerConfiguration from "../providerConfiguration.js";
import type * as providerRules from "../providerRules.js";
import type * as realtimeVoice from "../realtimeVoice.js";
import type * as revisions from "../revisions.js";
import type * as routineRules from "../routineRules.js";
import type * as routines from "../routines.js";
import type * as tools from "../tools.js";
import type * as transactional from "../transactional.js";
import type * as voice from "../voice.js";
import type * as workflowCurator from "../workflowCurator.js";
import type * as workflows from "../workflows.js";
import type * as workingMemory from "../workingMemory.js";
import type * as workingMemoryWorker from "../workingMemoryWorker.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  apns: typeof apns;
  apple: typeof apple;
  appointmentBookings: typeof appointmentBookings;
  assistantContext: typeof assistantContext;
  assistantCoordinator: typeof assistantCoordinator;
  assistantMail: typeof assistantMail;
  assistantSharing: typeof assistantSharing;
  calcom: typeof calcom;
  calendarAssistance: typeof calendarAssistance;
  calendarChanges: typeof calendarChanges;
  calendarFeeds: typeof calendarFeeds;
  calendarReading: typeof calendarReading;
  connections: typeof connections;
  connectorRequests: typeof connectorRequests;
  conversationValidation: typeof conversationValidation;
  coordinatorWorker: typeof coordinatorWorker;
  crons: typeof crons;
  dependencies: typeof dependencies;
  emailFiles: typeof emailFiles;
  emailFollowups: typeof emailFollowups;
  emailWatchRules: typeof emailWatchRules;
  emailWatches: typeof emailWatches;
  execution: typeof execution;
  files: typeof files;
  forwarding: typeof forwarding;
  gmailAttachments: typeof gmailAttachments;
  gmailDraftDiagnosticRules: typeof gmailDraftDiagnosticRules;
  gmailDraftDiagnosticSummary: typeof gmailDraftDiagnosticSummary;
  gmailDraftPreimage: typeof gmailDraftPreimage;
  gmailDrafts: typeof gmailDrafts;
  gmailMailbox: typeof gmailMailbox;
  gmailSending: typeof gmailSending;
  gmailWatch: typeof gmailWatch;
  google: typeof google;
  googleAdapter: typeof googleAdapter;
  googleCrypto: typeof googleCrypto;
  households: typeof households;
  http: typeof http;
  identityDeletion: typeof identityDeletion;
  inbound: typeof inbound;
  intake: typeof intake;
  jobs: typeof jobs;
  learnedWorkflows: typeof learnedWorkflows;
  legacy: typeof legacy;
  library: typeof library;
  mailAgent: typeof mailAgent;
  mailAttachments: typeof mailAttachments;
  mailConversation: typeof mailConversation;
  mailDrafts: typeof mailDrafts;
  mailFollowthrough: typeof mailFollowthrough;
  mailRoutineRetention: typeof mailRoutineRetention;
  mailRoutines: typeof mailRoutines;
  mailSending: typeof mailSending;
  mailbox: typeof mailbox;
  memory: typeof memory;
  memoryProposals: typeof memoryProposals;
  memoryRules: typeof memoryRules;
  microsoft: typeof microsoft;
  microsoftAdapter: typeof microsoftAdapter;
  modelContext: typeof modelContext;
  notifications: typeof notifications;
  personalTasks: typeof personalTasks;
  pickupAlternatives: typeof pickupAlternatives;
  pickupConflicts: typeof pickupConflicts;
  pickupDelivery: typeof pickupDelivery;
  pickupFollowup: typeof pickupFollowup;
  pickupMail: typeof pickupMail;
  pickupMailWorker: typeof pickupMailWorker;
  pickupMailRules: typeof pickupMailRules;
  pickupGmailAdapter: typeof pickupGmailAdapter;
  pickupIdentity: typeof pickupIdentity;
  pickups: typeof pickups;
  preparation: typeof preparation;
  privacy: typeof privacy;
  privateTasks: typeof privateTasks;
  providerConfiguration: typeof providerConfiguration;
  providerRules: typeof providerRules;
  realtimeVoice: typeof realtimeVoice;
  revisions: typeof revisions;
  routineRules: typeof routineRules;
  routines: typeof routines;
  tools: typeof tools;
  transactional: typeof transactional;
  voice: typeof voice;
  workflowCurator: typeof workflowCurator;
  workflows: typeof workflows;
  workingMemory: typeof workingMemory;
  workingMemoryWorker: typeof workingMemoryWorker;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
