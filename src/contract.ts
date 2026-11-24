/**
 * The shapes weivel/typescript's binding gives the definitions this plugin provides and calls: each operation one
 * async method taking its input parameters by name and answering its answer struct without its sizes, counts and
 * storage, a NULL text left out, a NULL array answered empty and NONE answered as a symbol. Only the members this
 * plugin reads or writes are named.
 */

export interface Pair {
  readonly name: string;
  readonly value: string;
}

export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly has_context: number;
  readonly context: number;
  readonly has_output: number;
  readonly output: number;
}

/** An account as the store keeps it: the members the store reads, and this plugin's own beside them. */
export interface StoredAccount {
  readonly id: string;
  readonly label?: string;
  readonly enabled?: boolean;
  readonly disabledReason?: string;
  readonly coolingDownUntil?: number;
  readonly expires?: number;
  readonly addedAt?: number;
  readonly quota?: unknown;
}

export interface AcquireAnswer {
  readonly kind: number;
  readonly id?: string;
  readonly available: number;
  readonly knows_available_at: number;
  readonly available_at: number;
}

export interface ReportArgument {
  readonly store: string;
  readonly id: string;
  readonly outcome: number;
  readonly now: number;
  readonly lane?: string;
  readonly reason?: string;
  readonly has_reset_at: number;
  readonly reset_at: number;
  readonly has_random: number;
  readonly random: number;
  readonly attempt: number;
  readonly base_milliseconds: number;
  readonly max_milliseconds: number;
  readonly quota?: unknown;
}

/** forebay-library's `accounts` service. */
export interface Accounts {
  list(input: { argument: { store: string } }): Promise<{ accounts: readonly StoredAccount[] }>;
  upsert(input: { argument: { store: string; account: Record<string, unknown> } }): Promise<{ outcome: number }>;
  remove(input: { argument: { store: string; id: string } }): Promise<{ removed: number }>;
  acquire(input: { argument: { store: string; lane: string; strategy: number; now: number } }): Promise<AcquireAnswer>;
  report(input: { argument: ReportArgument }): Promise<{ changed: number }>;
  token_expired(input: { argument: { has_expires: number; expires: number; now: number; has_skew_milliseconds: number; skew_milliseconds: number } }): Promise<{ expired: number }>;
  has_capacity(input: { argument: { pools: readonly unknown[] } }): Promise<{ capacity: number }>;
}

/** The host's `weivel.secrets`: any bytes under a name. */
export interface Secrets {
  get(input: { name: string }): Promise<{ bytes: Uint8Array } | symbol>;
  set(input: { name: string; bytes: Uint8Array }): Promise<void>;
  remove(input: { name: string }): Promise<void>;
}

export interface Config {
  get_tree(input: { key: string }): Promise<unknown>;
}

export interface Paths {
  plugin(input: Record<string, never>): Promise<string>;
}

export interface Log {
  write(input: { level: number; message: string }): Promise<void>;
}

export const ACQUIRE = { CLAIMED: 1, NONE: 2 } as const;

export const STRATEGY = { STICKY: 1, ROUND_ROBIN: 2, HYBRID: 3 } as const;

export const REPORT_OUTCOME = { SUCCESS: 1, RATE_LIMITED: 2, ERROR: 3, DISABLED: 4, QUOTA: 5 } as const;

export const UPSERT_OUTCOME = { ADDED: 1, UNCHANGED: 2, UPDATED: 3 } as const;

export const WEIVEL_LOG = { INFO: 3, WARN: 4 } as const;
