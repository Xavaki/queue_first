// Shared data model. Durable state lives in browser.storage.local under one
// revisioned record; live grants live in browser.storage.session.

export const SCHEMA_VERSION = 1;
export const DAILY_SKIPS = 2;

export type Category = 'MUSIC' | 'NON_MUSIC' | 'UNKNOWN';

export interface Classification {
  videoId: string;
  category: Category;
  /** Raw category string from player metadata, if any. */
  rawCategory: string | null;
  source: 'player_microformat' | 'user_override' | 'timeout' | 'error';
  parserVersion: number;
  at: number;
  title?: string;
  lengthSeconds?: number;
  isLive?: boolean;
  availability: 'available' | 'unavailable' | 'unknown';
  unavailableReason?: string;
}

export type SyncStatus = 'pending' | 'confirmed' | 'failed';
export type EntryStatus = 'active' | 'removed' | 'unavailable';
export type EntryOrigin = 'extension' | 'import' | 'remote';

export interface QueueEntry {
  entryId: string;
  videoId: string;
  setVideoId?: string;
  sequence: number;
  /** UTC ms of the first deliberate attempt (or of import/observation). */
  firstAttemptAt: number;
  title: string;
  category: Category | 'PENDING';
  sync: SyncStatus;
  status: EntryStatus;
  origin: EntryOrigin;
  unavailableReason?: string;
}

export type InitState = 'uninitialized' | 'ready';

export interface SnapshotItem {
  videoId: string;
  title: string;
  setVideoId?: string;
  playable: boolean;
  unavailableReason?: string;
}

export interface Snapshot {
  complete: boolean;
  items: SnapshotItem[];
  pages: number;
  error?: string;
}

export interface SnapshotInfo {
  at: number;
  complete: boolean;
  count: number;
  error?: string;
}

export interface AccountState {
  accountKey: string;
  init: InitState;
  nextSequence: number;
  entries: QueueEntry[];
  musicOverrides: Record<string, { at: number; title?: string }>;
  lastSnapshot: SnapshotInfo | null;
  queueRevision: number;
}

export interface SkipSpend {
  requestId: string;
  videoId: string;
  day: string;
  at: number;
}

export interface SkipLedger {
  /** Current allowance day (YYYY-MM-DD in the configured timezone). Never moves backwards. */
  day: string;
  used: number;
  spends: SkipSpend[];
}

export interface Settings {
  timezone: string;
}

export interface DurableState {
  schemaVersion: number;
  revision: number;
  settings: Settings;
  accounts: Record<string, AccountState>;
  categoryCache: Record<string, Classification>;
  skipLedger: SkipLedger;
  idempotency: Record<string, { at: number; result: unknown }>;
}

export type GrantKind = 'ordinary' | 'skip';

export interface Grant {
  grantId: string;
  kind: GrantKind;
  tabId: number;
  videoId: string;
  /** Account scope for ordinary grants; skip grants are profile-wide but still record it. */
  accountKey: string | null;
  queueRevision: number;
  entryId?: string;
  issuedAt: number;
}

export interface SessionState {
  grants: Record<string, Grant>;
  /** Last video each tab reported as its active player video. */
  tabVideo: Record<number, string | null>;
  tabAccount: Record<number, { accountKey: string | null; loggedIn: boolean }>;
  /** Short-lived selection locks making enqueue and skip mutually exclusive. */
  intents: Record<string, { kind: 'enqueue' | 'skip'; at: number }>;
  lastAccountKey: string | null;
}

export type BlockReason =
  | 'classifying'
  | 'signed_out'
  | 'account_unknown'
  | 'not_initialized'
  | 'not_queued'
  | 'queued_not_head'
  | 'head_needs_launch'
  | 'head_unconfirmed'
  | 'unavailable';

export interface PlaybackDecision {
  videoId: string;
  allowed: boolean;
  kind: 'music' | 'ordinary' | 'skip' | null;
  reason?: BlockReason;
  category: Category | 'PENDING';
  /** 1-based position among eligible queue entries, if queued. */
  position?: number;
  queueSize: number;
  head?: { videoId: string; title: string } | null;
}
